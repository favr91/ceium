"use client";
// Editor de programa (réplica de la página de producto del admin de Shopify): columna principal con ficha,
// multimedia, matriz de precios, formas de pago y cursos; columna lateral con estado, organización,
// modalidades, inscripciones y resumen. Barra de guardado contextual cuando hay cambios sin guardar.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { deleteProductAction, saveProduct, setProductsPublished, uploadProductImages } from "@/app/admin/(panel)/products/actions";
import { Icon } from "../Icon";
import { Modal, StatusBadge, useOutside, useToast } from "../ui";
import { PriceMatrix } from "./PriceMatrix";
import { ChoicesCard, CoursesCard, MediaCard, RichText } from "./parts";
import { parseMoney, planPreview, usd } from "./money";
import { CATEGORY_LABEL, CATEGORY_ORDER, statusOf, type Category, type EditorContext, type MediaDraft, type PlanRow, type ProductForm } from "./types";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slugify = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 200);
const SECTION_LABEL: Record<string, string> = { general: "Datos del programa", courses: "Cursos del diplomado", prices: "Precios", plans: "Formas de pago", organization: "Colecciones", media: "Multimedia" };
const ACTION_LABEL: Record<string, string> = {
  "product.create": "Programa creado",
  "product.update": "Programa actualizado",
  "price.create": "Precio agregado",
  "price.update": "Precio actualizado",
  "price.delete": "Precio quitado",
  "plan.create": "Forma de pago agregada",
  "plan.update": "Forma de pago actualizada",
  "plan.delete": "Forma de pago quitada",
  "diploma.courses": "Cursos del diplomado actualizados",
  "image.create": "Imagen agregada",
  "image.delete": "Imagen eliminada",
  "image.reorder": "Imágenes reordenadas",
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("es-VE", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Caracas" });
}

export function ProductEditor({ initial, ctx, canEdit }: { initial: ProductForm; ctx: EditorContext; canEdit: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState<ProductForm>(initial);
  const [base, setBase] = useState<ProductForm>(initial);
  const [seed, setSeed] = useState(0);
  const [slugTouched, setSlugTouched] = useState(!!initial.id);
  const [saving, start] = useTransition();
  const [error, setError] = useState<{ text: string; section?: string } | null>(null);
  const [tried, setTried] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  // Borrador de multimedia: imágenes quitadas y orden elegido (null = el del servidor). Subir es inmediato.
  const [imgRemoved, setImgRemoved] = useState<string[]>([]);
  const [imgOrder, setImgOrder] = useState<string[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [seoOpen, setSeoOpen] = useState(false);
  const toast = useToast();
  const [colRef, colOpen, setColOpen] = useOutside<HTMLDivElement>();
  const [colQ, setColQ] = useState("");
  const isNew = !form.id;
  const isDip = form.type === "DIPLOMA";

  // Nuevos datos del servidor (tras guardar): adoptarlos como base limpia.
  const initialJson = JSON.stringify(initial);
  const lastInitial = useRef(initialJson);
  useEffect(() => {
    if (lastInitial.current === initialJson) return;
    lastInitial.current = initialJson;
    setForm(initial);
    setBase(initial);
    setSeed((s) => s + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJson]);

  const images = useMemo(() => {
    const byId = new Map(ctx.images.map((i) => [i.id, i]));
    const ids = imgOrder ? [...imgOrder.filter((id) => byId.has(id)), ...ctx.images.map((i) => i.id).filter((id) => !imgOrder.includes(id))] : ctx.images.map((i) => i.id);
    return ids.filter((id) => !imgRemoved.includes(id)).map((id) => byId.get(id)!);
  }, [ctx.images, imgOrder, imgRemoved]);
  const media = useMemo<MediaDraft | null>(() => {
    const remove = ctx.images.map((i) => i.id).filter((id) => imgRemoved.includes(id));
    const kept = ctx.images.map((i) => i.id).filter((id) => !remove.includes(id));
    const order = images.map((i) => i.id);
    const reordered = order.join() !== kept.join();
    return remove.length || reordered ? { remove, order: reordered ? order : null } : null;
  }, [ctx.images, imgRemoved, images]);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(base) || pendingFiles.length > 0 || media !== null, [form, base, pendingFiles, media]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const set = <K extends keyof ProductForm>(k: K, v: ProductForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const errors = {
    title: !form.title.trim() ? "El título es obligatorio." : null,
    slug: !form.slug.trim() ? "El identificador de URL es obligatorio." : !SLUG_RE.test(form.slug.trim()) ? "Solo minúsculas, números y guiones (sin espacios ni tildes)." : null,
    moodle: form.type === "COURSE" && form.moodleCourseId.trim() && !/^\d+$/.test(form.moodleCourseId.trim()) ? "Debe ser un número entero." : null,
    modality: !form.offersOnline && !form.offersSemipresencial ? "Elige al menos una modalidad." : null,
    prices: form.prices.some((c) => Number.isNaN(parseMoney(c.price) as number) || Number.isNaN(parseMoney(c.installment) as number)) ? "Hay montos inválidos en la matriz." : null,
    discount: form.plans.some((p) => p.kind !== "MONTHLY" && p.enabled && (!/^\d{1,2}$/.test(p.discountPct.trim() || "0") || Number(p.discountPct) > 90)) ? "El descuento debe ser un entero entre 0 y 90." : null,
  };
  const firstError = Object.values(errors).find(Boolean);

  const discard = () => { setForm(base); setPendingFiles([]); setImgRemoved([]); setImgOrder(null); setSeed((s) => s + 1); setError(null); setTried(false); };

  const save = () => {
    setTried(true);
    if (firstError) { setError({ text: firstError }); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    setError(null);
    start(async () => {
      const r = await saveProduct(form, media ?? undefined);
      if (r.id && pendingFiles.length) {
        const fd = new FormData();
        for (const f of pendingFiles) fd.append("files", f);
        const up = await uploadProductImages(r.id, fd);
        if (!up.ok) r.notes = [...(r.notes ?? []), `Imágenes: ${up.error}`];
        setPendingFiles([]);
      }
      if (r.ok) {
        toast.show([isNew ? "Programa creado" : "Programa guardado", ...(r.notes ?? [])].join(" · "));
        setTried(false);
        if (isNew && r.id) router.replace(`/admin/products/${r.id}?creado=1`);
        else router.refresh();
      } else {
        setError({ text: r.error ?? "No se pudo guardar.", section: r.section });
        toast.show(r.error ?? "No se pudo guardar.", true);
        if (isNew && r.id) router.replace(`/admin/products/${r.id}`);
        else router.refresh();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  };

  const setCategory = (c: Category) => {
    const type = c === "DIPLOMA" ? "DIPLOMA" : "COURSE";
    setForm((f) => ({ ...f, category: c, type, ...(type !== f.type && ctx.defaultPlans ? { plans: ctx.defaultPlans[type], courseIds: [], moodleCourseId: "" } : {}) }));
  };

  const updatePlan = (kind: PlanRow["kind"], patch: Partial<PlanRow>) => set("plans", form.plans.map((p) => (p.kind === kind ? { ...p, ...patch } : p)));
  const status = statusOf({ published: base.published, publishedAt: base.publishedAt });
  const minPrice = form.prices.map((c) => parseMoney(c.price)).filter((x): x is number => typeof x === "number" && !Number.isNaN(x) && x > 0).sort((a, b) => a - b)[0];
  const minInst = form.prices.map((c) => parseMoney(c.installment)).filter((x): x is number => typeof x === "number" && !Number.isNaN(x) && x > 0).sort((a, b) => a - b)[0];
  const collections = ctx.collections.filter((c) => form.collectionIds.includes(c.id));
  const colAvail = ctx.collections.filter((c) => !form.collectionIds.includes(c.id) && c.title.toLowerCase().includes(colQ.trim().toLowerCase()));
  const storeUrl = `/products/${base.slug}`;
  const ro = !canEdit;

  const textField = (k: keyof ProductForm, label: string, opts: { area?: boolean; help?: string; placeholder?: string } = {}) => (
    <label className="field">
      <span>{label}</span>
      {opts.area ? (
        <textarea className="inp" value={form[k] as string} placeholder={opts.placeholder} readOnly={ro} onChange={(e) => set(k, e.target.value as never)} />
      ) : (
        <input className="inp" value={form[k] as string} placeholder={opts.placeholder} readOnly={ro} onChange={(e) => set(k, e.target.value as never)} />
      )}
      {opts.help ? <span className="help">{opts.help}</span> : null}
    </label>
  );

  return (
    <>
      {dirty && canEdit ? (
        <div className="savebar" role="region" aria-label="Cambios sin guardar">
          <div className="savebar-in">
            <div className="msg"><Icon name="alert" size={18} /> <span>{isNew ? "Programa sin guardar" : "Cambios sin guardar"}</span></div>
            <button type="button" className="btn btn-dark" onClick={() => (isNew ? router.push("/admin/products") : discard())} disabled={saving}>Descartar</button>
            <button type="button" className="btn btn-save" onClick={save} disabled={saving}>{saving ? "Guardando…" : "Guardar"}</button>
          </div>
        </div>
      ) : null}

      <div className="adm-page">
        <div className="adm-ph">
          <Link href="/admin/products" className="adm-back" aria-label="Programas"><Icon name="back" /></Link>
          <div className="grow">
            <h1>{isNew ? "Agregar programa" : base.title}</h1>
            {!isNew ? <StatusBadge status={status} /> : null}
          </div>
          {!isNew ? (
            <div className="adm-ph-actions">
              {status === "ACTIVE" ? <a className="btn btn-gray" href={storeUrl} target="_blank" rel="noreferrer">Ver en la tienda</a> : null}
              <span className="adm-pager">
                {ctx.prevId ? <Link href={`/admin/products/${ctx.prevId}`} aria-label="Programa anterior"><Icon name="prev" size={16} /></Link> : <span aria-hidden><Icon name="prev" size={16} /></span>}
                {ctx.nextId ? <Link href={`/admin/products/${ctx.nextId}`} aria-label="Programa siguiente"><Icon name="next" size={16} /></Link> : <span aria-hidden><Icon name="next" size={16} /></span>}
              </span>
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="banner critical" role="alert">
            <Icon name="alert" />
            <div>
              <b>{error.section ? `No se pudo guardar: ${SECTION_LABEL[error.section] ?? error.section}` : "Revisa el formulario"}</b>
              <div>{error.text}</div>
            </div>
            <button className="x" aria-label="Cerrar" onClick={() => setError(null)}><Icon name="x" size={16} /></button>
          </div>
        ) : null}
        {ro ? <div className="banner info"><Icon name="info" /><span>Solo lectura: tu rol no puede editar el catálogo.</span></div> : null}

        <div className="layout">
          <div className="col">
            {/* General */}
            <div className="card" id="sec-general">
              <label className="field">
                <span>Título</span>
                <input
                  className="inp"
                  name="title"
                  aria-label="Título"
                  value={form.title}
                  placeholder={isDip ? "Diplomado Universitario de…" : "Curso Universitario de…"}
                  aria-invalid={tried && !!errors.title}
                  readOnly={ro}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value, ...(!slugTouched ? { slug: slugify(e.target.value) } : {}) }))}
                />
                {tried && errors.title ? <span className="field-err"><Icon name="alert" size={18} />{errors.title}</span> : null}
              </label>
              <div className="field">
                <span className="label">Descripción</span>
                <RichText label="Descripción" value={form.descriptionHtml} seed={seed} onChange={(v) => set("descriptionHtml", v)} />
              </div>
              {textField("excerpt", "Extracto", { area: true, help: "Texto corto para las tarjetas de la tienda." })}
            </div>

            <MediaCard productId={form.id} images={images} pending={pendingFiles} onPending={setPendingFiles} onReorder={setImgOrder} onRemove={(id) => setImgRemoved((r) => [...r, id])} onMessage={toast.show} />

            {/* Precios */}
            <div className="card card-flush" id="sec-prices" style={error?.section === "prices" ? { boxShadow: "0 0 0 2px #c70a24" } : undefined}>
              <div className="card-h">
                <h2>Precios</h2>
                <span className="small muted">USD · precio de lista del programa completo</span>
              </div>
              <p className="muted" style={{ padding: "0 16px 12px" }}>
                Un precio por modalidad y sede. Deja vacío donde no se vende. {isDip ? "La cuota mensual es lo que se cobra por cada curso con «Paga mes a mes»." : ""}
              </p>
              {!form.offersOnline && !form.offersSemipresencial ? (
                <p className="field-err" style={{ padding: "0 16px 12px" }}>Activa al menos una modalidad para cargar precios.</p>
              ) : (
                <PriceMatrix
                  type={form.type}
                  cells={form.prices}
                  sedes={ctx.sedes}
                  choices={ctx.choices}
                  plans={form.plans}
                  offersOnline={form.offersOnline}
                  offersSemi={form.offersSemipresencial}
                  courseCount={form.courseIds.length}
                  disabled={ro}
                  onChange={(cells) => set("prices", cells)}
                />
              )}
              <div className="card-foot">
                <span>{!form.offersOnline ? "No se ofrece online. " : ""}{!form.offersSemipresencial ? "No se ofrece semipresencial. " : ""}Cambia las modalidades en la columna derecha.</span>
                {!isNew && form.offersSemipresencial ? <Link className="btn btn-plain" href={`/admin/cohorts?product=${form.id}`}>Cohortes y cupos</Link> : null}
              </div>
            </div>

            {/* Formas de pago */}
            <div className="card card-flush" id="sec-plans">
              <div className="card-h"><h2>Formas de pago</h2></div>
              <ul className="sl">
                {form.plans.map((p) => {
                  const on = p.enabled && p.active;
                  const monthlyBlocked = p.kind === "MONTHLY" && form.courseIds.length === 0;
                  const ex = minPrice ? planPreview(minPrice, p.kind === "MONTHLY" ? (minInst ?? null) : null, p.kind, Number(p.discountPct) || 0, p.kind === "MONTHLY" ? form.courseIds.length || 1 : p.kind === "HALF" ? 2 : 1) : null;
                  return (
                    <li key={p.kind} style={{ padding: "12px 16px", alignItems: "flex-start" }} data-plan={p.kind}>
                      <input
                        type="checkbox"
                        className="toggle"
                        role="switch"
                        style={{ marginTop: 6 }}
                        aria-label={`Ofrecer ${p.label}`}
                        checked={on}
                        disabled={ro || (monthlyBlocked && !on)}
                        onChange={(e) => updatePlan(p.kind, e.target.checked ? { enabled: true, active: true } : p.id ? { active: false } : { enabled: false })}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="grid2" style={{ gridTemplateColumns: p.kind === "MONTHLY" ? "1fr" : "1fr 120px" }}>
                          <label className="field" style={{ margin: 0 }}>
                            <span className="small muted">{p.kind === "FULL" ? "Pago total" : p.kind === "HALF" ? "Mitad ahora, mitad después" : "Mes a mes (una cuota por curso)"}</span>
                            <input className="inp" value={p.label} aria-label={`Texto de ${p.kind}`} readOnly={ro} disabled={!on} onChange={(e) => updatePlan(p.kind, { label: e.target.value })} />
                          </label>
                          {p.kind !== "MONTHLY" ? (
                            <label className="field" style={{ margin: 0 }}>
                              <span className="small muted">Descuento</span>
                              <div className="inp-affix">
                                <input className="inp has-suf num" inputMode="numeric" aria-label={`Descuento ${p.label}`} value={p.discountPct} readOnly={ro} disabled={!on} aria-invalid={tried && !!errors.discount} onChange={(e) => updatePlan(p.kind, { discountPct: e.target.value.replace(/[^\d]/g, "").slice(0, 2) })} />
                                <span className="suf">%</span>
                              </div>
                            </label>
                          ) : null}
                        </div>
                        <div className="small muted" style={{ marginTop: 6 }}>
                          {monthlyBlocked ? "Agrega los cursos del diplomado para habilitar el pago mes a mes." : ex && on ? (
                            p.kind === "FULL" ? <>Ej.: {usd(minPrice!)} → <b className="mono">{usd(ex.totalCents)}</b> en un solo pago</>
                            : p.kind === "HALF" ? <>Ej.: <b className="mono">{usd(ex.dueNowCents)}</b> hoy y {usd(ex.totalCents - ex.dueNowCents)} después (total {usd(ex.totalCents)})</>
                            : <>Ej.: <b className="mono">{ex.n} cuotas de {usd(ex.dueNowCents)}</b> · cada cuota pagada matricula el siguiente curso</>
                          ) : !on ? (p.id ? "Desactivada: no se ofrece en la tienda (los pedidos existentes no cambian)." : "No se ofrece.") : "Carga un precio para ver el ejemplo."}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {tried && errors.discount ? <p className="field-err" style={{ padding: "0 16px 12px" }}>{errors.discount}</p> : null}
            </div>

            {isDip ? <CoursesCard courseIds={form.courseIds} courses={ctx.courses} onChange={(ids) => set("courseIds", ids)} error={error?.section === "courses" ? error.text : undefined} /> : null}

            {!isDip && form.id ? <ChoicesCard productId={form.id} choices={ctx.choices} onMessage={toast.show} /> : null}

            {/* Ficha */}
            <div className="card" id="sec-details">
              <div className="card-h"><h2>Ficha del programa</h2><span className="small muted">Se muestra en la página del programa</span></div>
              <div className="grid2">
                {textField("duration", "Duración", { placeholder: isDip ? "1 mes por curso" : "1 mes" })}
                {textField("eventDateText", "Fechas (texto)", { placeholder: "21 y 22 de noviembre 2025" })}
              </div>
              {textField("audience", "Dirigido a", { area: true })}
              {textField("requirements", "Requisitos", { area: true })}
              <div className="grid2">
                {textField("certificateTitle", "Título del certificado", { placeholder: isDip ? "Diplomado de 9 cursos" : "Certificado" })}
                {textField("endorsementTitle", "Aval", { placeholder: "Avalado por la UCLA" })}
              </div>
              {textField("certificateText", "Texto del certificado", { area: true })}
              {textField("endorsementText", "Texto del aval", { area: true })}
              <div className="grid2">
                {textField("faculty", "Docentes", { area: true, help: "Uno por línea." })}
                {textField("benefits", "Beneficios", { area: true, help: "Uno por línea." })}
              </div>
              {textField("syllabusUrl", "Contenido descargable (URL del PDF)", { placeholder: "https://" })}
            </div>

            {/* SEO */}
            <div className="card" id="sec-seo">
              <div className="card-h">
                <h2>Publicación en buscadores</h2>
                <button type="button" className="btn btn-tertiary btn-icon" aria-label="Editar publicación en buscadores" aria-expanded={seoOpen} onClick={() => setSeoOpen((v) => !v)}><Icon name={seoOpen ? "chevronUp" : "chevronDown"} /></button>
              </div>
              <div className="seo-prev">
                {form.title || form.seoTitle ? (
                  <>
                    <div className="u">ceium.net › products › {form.slug || "…"}</div>
                    <div className="t">{form.seoTitle || form.title}</div>
                    <div className="d">{(form.seoDescription || form.excerpt || form.descriptionHtml.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 160) || "Agrega una descripción para ver cómo aparecerá en los buscadores."}</div>
                  </>
                ) : (
                  <p className="muted">Agrega un título y una descripción para ver cómo podría aparecer este programa en los buscadores.</p>
                )}
              </div>
              {seoOpen || (tried && errors.slug) ? (
                <>
                  <div className="divider" />
                  {textField("seoTitle", "Título de la página", { help: `${(form.seoTitle || form.title).length} de 70 caracteres usados` })}
                  {textField("seoDescription", "Metadescripción", { area: true, help: `${form.seoDescription.length} de 160 caracteres usados` })}
                  <label className="field">
                    <span>Identificador de URL</span>
                    <div className="inp-affix">
                      <span className="pre" style={{ left: 12 }}>/products/</span>
                      <input className="inp" style={{ paddingLeft: 78 }} name="slug" value={form.slug} readOnly={ro} aria-invalid={tried && !!errors.slug} onChange={(e) => { setSlugTouched(true); set("slug", e.target.value); }} />
                    </div>
                    {tried && errors.slug ? <span className="field-err"><Icon name="alert" size={18} />{errors.slug}</span> : <span className="help">ceium.net/products/{form.slug || "…"}</span>}
                  </label>
                </>
              ) : null}
            </div>
          </div>

          {/* ───────── Lateral ───────── */}
          <div className="col">
            <div className="card">
              <label className="field">
                <span className="strong">Estado</span>
                <select className="inp" aria-label="Estado" value={form.published ? "ACTIVE" : "INACTIVE"} disabled={ro} onChange={(e) => set("published", e.target.value === "ACTIVE")}>
                  <option value="ACTIVE">Activo</option>
                  <option value="INACTIVE">{base.publishedAt ? "Archivado" : "Borrador"}</option>
                </select>
                <span className="help">{form.published ? "Visible y a la venta en la tienda." : "Oculto en la tienda; los pedidos, matrículas y certificados siguen intactos."}</span>
              </label>
            </div>

            <div className="card">
              <div className="card-h"><h2>Organización del programa</h2></div>
              <label className="field">
                <span>Categoría</span>
                <select className="inp" aria-label="Categoría" value={form.category} disabled={!isNew || ro} onChange={(e) => setCategory(e.target.value as Category)}>
                  {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                </select>
                <span className="help">{isNew ? "Un diplomado agrupa cursos; cursos y talleres matriculan un curso de Moodle." : "La categoría se fija al crear el programa."}</span>
              </label>
              <div className="field" ref={colRef}>
                <span className="label">Colecciones</span>
                <div className="combo">
                  <input className="inp" placeholder="Buscar colecciones" aria-label="Agregar a colección" value={colQ} disabled={ro} onFocus={() => setColOpen(true)} onChange={(e) => { setColQ(e.target.value); setColOpen(true); }} />
                  {colOpen && !ro ? (
                    <div className="popover" role="listbox" aria-label="Colecciones">
                      {colAvail.length ? colAvail.map((c) => (
                        <button type="button" key={c.id} role="option" aria-selected={false} className="opt" onClick={() => { set("collectionIds", [...form.collectionIds, c.id]); setColQ(""); setColOpen(false); }}>{c.title}</button>
                      )) : <div className="ttl">Sin más colecciones</div>}
                    </div>
                  ) : null}
                </div>
                {collections.length ? (
                  <div className="chips">
                    {collections.map((c) => (
                      <span className="chip" key={c.id}>
                        {c.title}
                        {!ro ? <button type="button" aria-label={`Quitar de ${c.title}`} onClick={() => set("collectionIds", form.collectionIds.filter((x) => x !== c.id))}><Icon name="x" size={14} /></button> : null}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="card" id="sec-modality">
              <div className="card-h"><h2>Modalidades</h2></div>
              <label className="check">
                <input type="checkbox" checked={form.offersOnline} disabled={ro} onChange={(e) => set("offersOnline", e.target.checked)} />
                <span className="t">Online<span className="d">Clases en la plataforma, sin sede.</span></span>
              </label>
              <label className="check" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={form.offersSemipresencial} disabled={ro} onChange={(e) => set("offersSemipresencial", e.target.checked)} />
                <span className="t">Semipresencial<span className="d">Por sede, con cohortes y cupo.</span></span>
              </label>
              {tried && errors.modality ? <p className="field-err">{errors.modality}</p> : null}
            </div>

            <div className="card">
              <div className="card-h"><h2>Inscripciones</h2></div>
              <label className="field">
                <span>Último día de inscripción</span>
                <input className="inp" type="date" value={form.enrollmentDeadline} readOnly={ro} onChange={(e) => set("enrollmentDeadline", e.target.value)} />
                <span className="help">Opcional. Al día siguiente la tienda muestra «Inscripciones cerradas».</span>
              </label>
              {textField("enrollmentNote", "Aviso", { placeholder: "✍ Inscripciones abiertas." })}
            </div>

            {form.type === "COURSE" ? (
              <div className="card">
                <div className="card-h"><h2>Moodle</h2></div>
                <label className="field">
                  <span>ID del curso en Moodle</span>
                  <input className="inp num" inputMode="numeric" value={form.moodleCourseId} readOnly={ro} aria-invalid={!!errors.moodle || undefined} onChange={(e) => set("moodleCourseId", e.target.value)} />
                  {errors.moodle ? <span className="field-err">{errors.moodle}</span> : <span className="help">Al confirmarse el pago se matricula en este curso.</span>}
                </label>
                {ctx.stats.inDiplomas.length ? (
                  <p className="small muted">Forma parte de: {ctx.stats.inDiplomas.map((d, i) => <span key={d.id}>{i ? ", " : ""}<Link href={`/admin/products/${d.id}`} style={{ color: "var(--p-link)" }}>{d.title}</Link></span>)}</p>
                ) : null}
              </div>
            ) : null}

            {!isNew ? (
              <div className="card">
                <div className="card-h"><h2>Resumen</h2></div>
                <dl className="kv">
                  <dt>Pedidos</dt><dd>{ctx.stats.orders}</dd>
                  <dt>Pedidos en curso</dt><dd>{ctx.stats.liveOrders}</dd>
                  <dt>Matrículas</dt><dd>{ctx.stats.enrollments}</dd>
                  <dt>Cohortes abiertas</dt><dd>{ctx.stats.cohortsOpen} de {ctx.stats.cohorts}</dd>
                  <dt>Creado</dt><dd className="small">{ctx.createdAt ? fmtDate(ctx.createdAt) : "—"}</dd>
                </dl>
              </div>
            ) : null}

            {ctx.audit.length ? (
              <div className="card">
                <div className="card-h"><h2>Historial</h2></div>
                <ul className="tl">
                  {ctx.audit.map((a) => (
                    <li key={a.id}>
                      <div>{ACTION_LABEL[a.action] ?? a.action}{a.fields.length && a.action.endsWith("update") ? <span className="muted"> · {a.fields.slice(0, 3).join(", ")}{a.fields.length > 3 ? "…" : ""}</span> : null}</div>
                      <div className="small muted">{fmtDate(a.when)}{a.who ? ` · ${a.who}` : ""}</div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>

        {canEdit ? (
          <div className="page-foot">
            <div className="btn-group">
              {!isNew ? (
                <>
                  {status === "ACTIVE" ? (
                    <button type="button" className="btn" disabled={saving} onClick={() => start(async () => { const r = await setProductsPublished([form.id!], false); toast.show(r.ok ? "Programa archivado" : r.error, !r.ok); router.refresh(); })}>Archivar programa</button>
                  ) : null}
                  <button type="button" className="btn btn-critical" onClick={() => setConfirmDelete(true)}>Eliminar programa</button>
                </>
              ) : null}
            </div>
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving || (!dirty && !isNew)}>{saving ? "Guardando…" : "Guardar"}</button>
          </div>
        ) : null}
      </div>

      {confirmDelete ? (
        <Modal
          title={`¿Eliminar «${base.title}»?`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>Cancelar</button>
              <button type="button" className="btn btn-critical" disabled={saving} onClick={() => start(async () => {
                const r = await deleteProductAction(form.id!);
                if (r.ok) { setBase(form); router.push("/admin/products"); }
                else { setConfirmDelete(false); toast.show(r.error, true); }
              })}>Eliminar programa</button>
            </>
          }
        >
          <p>Se borran sus precios, formas de pago, imágenes y cohortes sin ventas. No se puede deshacer.</p>
          {ctx.stats.orders || ctx.stats.enrollments ? <p className="field-err" style={{ marginTop: 8 }}>Este programa ya tiene pedidos o matrículas: no se puede eliminar, solo archivar.</p> : null}
        </Modal>
      ) : null}
      {toast.node}
    </>
  );
}
