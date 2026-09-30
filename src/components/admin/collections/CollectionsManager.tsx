"use client";
// Colecciones (réplica de Productos › Colecciones de Shopify): listado con estado y número de programas; alta y
// edición en un modal con título, identificador (URL /collections/<slug>), visibilidad y los programas en orden.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { deleteCollectionAction, saveCollection, type CollectionInput } from "@/app/admin/(panel)/collections/actions";
import { Icon } from "../Icon";
import { Modal, useToast } from "../ui";

export interface CollectionRow {
  id: string;
  title: string;
  slug: string;
  descriptionHtml: string;
  published: boolean;
  diplomaTitle: string | null;
  productIds: string[];
}
export interface ProductOption {
  id: string;
  title: string;
  published: boolean;
  image: string | null;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slugify = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
const EMPTY: CollectionInput = { title: "", slug: "", descriptionHtml: "", published: true, productIds: [] };

export function CollectionsManager({ collections, products, canEdit }: { collections: CollectionRow[]; products: ProductOption[]; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [edit, setEdit] = useState<CollectionInput | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const [tried, setTried] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const open = (c?: CollectionRow) => {
    setErr(null);
    setTried(false);
    setAdding("");
    setConfirmDel(false);
    setSlugTouched(!!c);
    setEdit(c ? { id: c.id, title: c.title, slug: c.slug, descriptionHtml: c.descriptionHtml, published: c.published, productIds: [...c.productIds] } : { ...EMPTY, productIds: [] });
  };
  const errors = edit
    ? {
        title: !edit.title.trim() ? "El título es obligatorio." : null,
        slug: !edit.slug.trim() ? "El identificador es obligatorio." : !SLUG_RE.test(edit.slug.trim()) ? "Solo minúsculas, números y guiones." : collections.some((c) => c.slug === edit.slug.trim() && c.id !== edit.id) ? "Ya existe una colección con ese identificador." : null,
      }
    : { title: null, slug: null };
  const firstErr = errors.title ?? errors.slug;

  const submit = () => {
    if (!edit) return;
    setTried(true);
    if (firstErr) return;
    start(async () => {
      const r = await saveCollection(edit);
      if (r.ok) {
        toast.show(edit.id ? "Colección guardada" : "Colección creada");
        setEdit(null);
        router.refresh();
      } else setErr(r.error);
    });
  };
  const remove = () => {
    if (!edit?.id) return;
    start(async () => {
      const r = await deleteCollectionAction(edit.id!);
      if (r.ok) {
        toast.show("Colección eliminada");
        setEdit(null);
        router.refresh();
      } else setErr(r.error);
    });
  };
  const move = (i: number, d: -1 | 1) =>
    setEdit((e) => {
      if (!e) return e;
      const ids = [...e.productIds];
      const j = i + d;
      if (j < 0 || j >= ids.length) return e;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      return { ...e, productIds: ids };
    });

  const published = collections.filter((c) => c.published).length;

  return (
    <>
      <div className="adm-ph">
        <div className="grow">
          <h1>Colecciones</h1>
          <div className="meta">
            {published} {published === 1 ? "publicada" : "publicadas"} de {collections.length} · agrupan los programas en la tienda y el menú
          </div>
        </div>
        <div className="adm-ph-actions">
          <Link className="btn btn-gray hide-sm" href="/admin/products">Programas</Link>
          {canEdit ? <button type="button" className="btn btn-primary" onClick={() => open()}>Crear colección</button> : null}
        </div>
      </div>
      {!canEdit ? (
        <div className="banner info" role="status">
          <Icon name="info" />
          <span>Como asistente puedes ver las colecciones; editarlas es del administrador comercial o del super administrador.</span>
        </div>
      ) : null}

      <div className="card card-flush">
        {collections.length === 0 ? (
          <div className="ix-empty">
            <Icon name="product" size={40} />
            <h3>Sin colecciones</h3>
            <p className="muted">Crea una colección para agrupar programas en la tienda.</p>
          </div>
        ) : (
          <>
            <table className="ix" aria-label="Colecciones">
              <thead>
                <tr>
                  <th>Título</th>
                  <th className="num">Programas</th>
                  <th>Estado</th>
                  <th className="h-md">Enlace</th>
                  <th><span className="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                {collections.map((c) => (
                  <tr key={c.id} data-collection={c.slug} onClick={(e) => { if ((e.target as HTMLElement).closest("a,button")) return; if (canEdit) open(c); }}>
                    <td className="c-title">
                      <span className="title">{c.title}</span>
                      {c.diplomaTitle ? <div className="sub">Cursos de un diplomado</div> : null}
                    </td>
                    <td className="num mono">{c.productIds.length}</td>
                    <td>{c.published ? <span className="badge success">Publicada</span> : <span className="badge">Oculta</span>}</td>
                    <td className="h-md">
                      <a className="lnk" href={`/collections/${c.slug}`} target="_blank" rel="noreferrer" title={`/collections/${c.slug}`} style={{ display: "inline-block", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "bottom" }}>/collections/{c.slug}</a>
                    </td>
                    <td className="num">{canEdit ? <button type="button" className="btn" aria-label={`Editar ${c.title}`} onClick={() => open(c)}>Editar</button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="ix-list" aria-label="Colecciones">
              {collections.map((c) => (
                <li key={c.id}>
                  <button type="button" style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: 0, padding: 0, font: "inherit", color: "inherit" }} disabled={!canEdit} onClick={() => open(c)}>
                    <span className="t">{c.title}</span>
                    <span className="s">/collections/{c.slug} · {c.productIds.length} {c.productIds.length === 1 ? "programa" : "programas"}</span>
                    <span className="b">{c.published ? <span className="badge success">Publicada</span> : <span className="badge">Oculta</span>}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="card-foot">
          <span>{collections.length} colecciones</span>
          <span>El orden de los programas es el de la tienda</span>
        </div>
      </div>

      {edit ? (
        <Modal
          title={edit.id ? `Editar ${edit.title || "colección"}` : "Crear colección"}
          onClose={() => setEdit(null)}
          footer={
            <>
              {edit.id ? (
                confirmDel ? (
                  <button type="button" className="btn btn-critical" style={{ marginRight: "auto" }} disabled={pending} onClick={remove}>Confirmar eliminación</button>
                ) : (
                  <button type="button" className="btn btn-plain" style={{ marginRight: "auto", color: "var(--p-critical)" }} onClick={() => setConfirmDel(true)}>Eliminar colección</button>
                )
              ) : null}
              <button type="button" className="btn" onClick={() => setEdit(null)}>Cancelar</button>
              <button type="button" className="btn btn-primary" disabled={pending} onClick={submit}>{pending ? "Guardando…" : edit.id ? "Guardar" : "Crear colección"}</button>
            </>
          }
        >
          {err ? <div className="banner critical" role="alert"><Icon name="alert" /><span>{err}</span></div> : null}
          <div className="grid2">
            <label className="field">
              <span>Título</span>
              <input className="inp" aria-label="Título de la colección" value={edit.title} autoFocus aria-invalid={tried && !!errors.title} onChange={(e) => { const v = e.target.value; setEdit((x) => x && { ...x, title: v, ...(!slugTouched ? { slug: slugify(v) } : {}) }); }} />
              {tried && errors.title ? <span className="field-err">{errors.title}</span> : null}
            </label>
            <label className="field">
              <span>Identificador</span>
              <input className="inp" aria-label="Identificador de la colección" value={edit.slug} aria-invalid={tried && !!errors.slug} onChange={(e) => { setSlugTouched(true); const v = e.target.value; setEdit((x) => x && { ...x, slug: v }); }} />
              {tried && errors.slug ? <span className="field-err">{errors.slug}</span> : <span className="help">/collections/{edit.slug || "…"}</span>}
            </label>
          </div>
          <label className="field">
            <span>Descripción (HTML)</span>
            <textarea className="inp" rows={2} aria-label="Descripción" value={edit.descriptionHtml} onChange={(e) => { const v = e.target.value; setEdit((x) => x && { ...x, descriptionHtml: v }); }} />
          </label>
          <label className="check" style={{ marginBottom: 12 }}>
            <input type="checkbox" aria-label="Publicada en la tienda" checked={edit.published} onChange={(e) => { const v = e.target.checked; setEdit((x) => x && { ...x, published: v }); }} />
            <span className="t">Publicada en la tienda<span className="d">Una colección oculta no se muestra en la tienda ni en el menú.</span></span>
          </label>
          <div className="divider" />
          <div className="label">Programas ({edit.productIds.length})</div>
          <ul className="sl" aria-label="Programas de la colección" style={{ maxHeight: 280, overflow: "auto", marginBottom: 8 }}>
            {edit.productIds.map((id, i) => {
              const p = byId.get(id);
              return (
                <li key={id} className="row" style={{ padding: "4px 0", borderTop: i ? "1px solid var(--p-border-2)" : 0 }}>
                  <span className="mono small muted" style={{ width: 20 }}>{i + 1}</span>
                  <span className="thumb" style={{ width: 32, height: 32 }}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- imágenes del catálogo */}
                    {p?.image ? <img src={p.image} alt="" /> : <Icon name="product" size={16} />}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {p?.title ?? id} {p && !p.published ? <span className="badge sm">Oculto</span> : null}
                  </span>
                  <button type="button" className="btn btn-tertiary btn-icon" aria-label={`Subir ${p?.title ?? id}`} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="chevronUp" size={16} /></button>
                  <button type="button" className="btn btn-tertiary btn-icon" aria-label={`Bajar ${p?.title ?? id}`} disabled={i === edit.productIds.length - 1} onClick={() => move(i, 1)}><Icon name="chevronDown" size={16} /></button>
                  <button type="button" className="btn btn-tertiary btn-icon" aria-label={`Quitar ${p?.title ?? id}`} onClick={() => setEdit((x) => x && { ...x, productIds: x.productIds.filter((y) => y !== id) })}><Icon name="x" size={16} /></button>
                </li>
              );
            })}
            {!edit.productIds.length ? <li className="muted small">Sin programas.</li> : null}
          </ul>
          <div className="row">
            <select className="inp" aria-label="Agregar programa" value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Agregar un programa…</option>
              {products.filter((p) => !edit.productIds.includes(p.id)).map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
            <button type="button" className="btn" disabled={!adding} onClick={() => { setEdit((x) => x && { ...x, productIds: [...x.productIds, adding] }); setAdding(""); }}>Agregar</button>
          </div>
        </Modal>
      ) : null}
      {toast.node}
    </>
  );
}
