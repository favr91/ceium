"use client";
/* eslint-disable @next/next/no-img-element -- miniaturas del catálogo (CDN de ceium.net y /uploads): sin optimización de next/image */
// Tarjetas del editor de programa: descripción enriquecida, multimedia, cursos del diplomado, opciones de compra.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  deleteChoiceAction,
  saveChoiceAction,
  updateImageAltAction,
  uploadProductImages,
} from "@/app/admin/(panel)/products/actions";
import { sizedImage } from "@/components/store/image-url";
import { Icon } from "../Icon";
import { Modal, StatusBadge, useOutside } from "../ui";
import type { ChoiceItem, EditorContext, ImageItem } from "./types";

// ───────── Descripción (texto enriquecido con vista HTML) ─────────

function ToolButton({ icon, title, disabled, onRun }: { icon: string; title: string; disabled: boolean; onRun: () => void }) {
  return (
    <button type="button" title={title} aria-label={title} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onRun}>
      <Icon name={icon} size={18} />
    </button>
  );
}

export function RichText({ value, onChange, seed, label }: { value: string; onChange: (html: string) => void; seed: number; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState(false);
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value) ref.current.innerHTML = value;
    // Solo al montar / descartar cambios (seed): no pisar lo que se está escribiendo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, html]);
  const cmd = (c: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(c, false, arg);
    if (ref.current) onChange(ref.current.innerHTML);
  };
  return (
    <div className="rte">
      <div className="rte-bar" role="toolbar" aria-label="Formato">
        <ToolButton icon="h" title="Párrafo" disabled={html} onRun={() => cmd("formatBlock", "p")} />
        <span className="sep" />
        <ToolButton icon="bold" title="Negrita" disabled={html} onRun={() => cmd("bold")} />
        <ToolButton icon="italic" title="Cursiva" disabled={html} onRun={() => cmd("italic")} />
        <ToolButton icon="underline" title="Subrayado" disabled={html} onRun={() => cmd("underline")} />
        <span className="sep" />
        <ToolButton icon="ul" title="Lista con viñetas" disabled={html} onRun={() => cmd("insertUnorderedList")} />
        <ToolButton icon="ol" title="Lista numerada" disabled={html} onRun={() => cmd("insertOrderedList")} />
        <button type="button" title="Enlace" aria-label="Enlace" disabled={html} onMouseDown={(e) => e.preventDefault()} onClick={() => { const u = window.prompt("URL del enlace (https://…)"); if (u) cmd("createLink", u); }}>
          <Icon name="link" size={18} />
        </button>
        <span className="right" />
        <button type="button" title={html ? "Ver texto" : "Mostrar HTML"} aria-label="Mostrar HTML" aria-pressed={html} className={html ? "on" : undefined} onClick={() => setHtml((v) => !v)}>
          <Icon name="code" size={18} />
        </button>
      </div>
      {html ? (
        <textarea className="rte-html" aria-label={`${label} (HTML)`} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      ) : (
        <div ref={ref} className="rte-body" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label={label} onInput={(e) => onChange((e.target as HTMLDivElement).innerHTML)} />
      )}
    </div>
  );
}

// ───────── Multimedia ─────────

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MB = (n: number) => `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;

/**
 * Las fotos de teléfono (JPG de 3–15 MB) se reducen en el navegador antes de enviarlas: suben en segundos aunque
 * la conexión sea lenta. La optimización final (WebP en varios anchos, sin metadatos) la hace el servidor.
 * Solo JPG: un PNG puede tener transparencia, que el JPG perdería.
 */
async function shrinkPhoto(f: File): Promise<File> {
  if (f.type !== "image/jpeg" || f.size <= 1.5 * 1024 * 1024) return f;
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: "from-image" });
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    return blob && blob.size < f.size ? new File([blob], f.name.replace(/\.[^.]*$/, "") + ".jpg", { type: "image/jpeg" }) : f;
  } catch {
    return f; // navegador sin soporte: se envía tal cual y el servidor la optimiza igual
  }
}

/** Sube las imágenes de a una (cada envío cabe en el límite del servidor). Devuelve cuántas subieron y los errores. */
export async function uploadImageFiles(productId: string, files: File[], onProgress?: (i: number) => void): Promise<{ ok: number; errors: string[] }> {
  let ok = 0;
  const errors: string[] = [];
  for (const [i, f] of files.entries()) {
    onProgress?.(i);
    const file = await shrinkPhoto(f);
    const name = files.length > 1 ? `«${f.name}»: ` : "";
    if (file.size > MAX_UPLOAD_BYTES) {
      errors.push(`${name}pesa ${MB(file.size)}; el máximo es 10 MB.`);
      continue;
    }
    const fd = new FormData();
    fd.append("files", file);
    const r = await uploadProductImages(productId, fd).catch(() => ({ ok: false as const, error: "No se pudo enviar (revisa la conexión)." }));
    if (r.ok) ok++;
    else errors.push(`${name}${r.error}`);
  }
  return { ok, errors };
}

/**
 * Subir y editar el texto alternativo se guardan al instante; quitar y reordenar son cambios del editor
 * (`images` ya viene con el borrador aplicado) que se confirman o descartan con la barra de guardado.
 */
export function MediaCard({ productId, images: order, pending, onPending, onReorder, onRemove, onMessage }: { productId: string | null; images: ImageItem[]; pending: File[]; onPending: (f: File[]) => void; onReorder: (ids: string[]) => void; onRemove: (id: string) => void; onMessage: (t: string, err?: boolean) => void }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [edit, setEdit] = useState<ImageItem | null>(null);
  const [alt, setAlt] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const upload = (files: File[], link?: string) => {
    if (!productId) { onPending([...pending, ...files]); return; }
    start(async () => {
      const r = await uploadImageFiles(productId, files, (i) => setProgress(files.length > 1 ? `Subiendo y optimizando ${i + 1} de ${files.length}…` : "Subiendo y optimizando…"));
      if (link) {
        const fd = new FormData();
        fd.set("url", link);
        const u = await uploadProductImages(productId, fd);
        if (u.ok) r.ok++;
        else r.errors.push(u.error);
      }
      setProgress(null);
      if (r.errors.length) onMessage(r.errors.join(" "), true);
      else onMessage(r.ok > 1 ? "Imágenes agregadas" : "Imagen agregada");
      router.refresh();
    });
  };

  const move = (from: string, to: string) => {
    if (from === to) return;
    const ids = order.map((i) => i.id);
    const a = ids.indexOf(from), b = ids.indexOf(to);
    ids.splice(b, 0, ids.splice(a, 1)[0]);
    onReorder(ids);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (files.length) upload(files);
  };

  const empty = order.length === 0 && pending.length === 0;
  return (
    <div className="card" id="sec-media">
      <div className="card-h">
        <h2>Multimedia</h2>
        {progress ? <span className="muted" role="status" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{progress}</span> : null}
        {!empty ? (
          <div className="btn-group">
            <button type="button" className="btn btn-plain" onClick={() => setUrlOpen(true)}>Agregar desde URL</button>
          </div>
        ) : null}
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple hidden aria-label="Subir imágenes" data-testid="media-input" onChange={(e) => { const f = [...(e.target.files ?? [])]; if (f.length) upload(f); e.target.value = ""; }} />
      {empty ? (
        <div className={`drop big${over ? " over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
          <div className="btn-group">
            <button type="button" className="btn" onClick={() => input.current?.click()} disabled={busy}>Subir nuevas</button>
            <button type="button" className="btn btn-plain" onClick={() => setUrlOpen(true)}>Agregar desde URL</button>
          </div>
          <span className="muted">JPG, PNG, WEBP, GIF o AVIF (máx. 10 MB). Se optimizan solas: sube la foto tal cual.</span>
        </div>
      ) : (
        <div className="media has-main" onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }} onDrop={(e) => { if (e.dataTransfer.files.length) onDrop(e); }}>
          {order.map((img, i) => (
            <div
              key={img.id}
              className={`media-item${drag === img.id ? " dragging" : ""}`}
              draggable
              onDragStart={(e) => { setDrag(img.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => setDrag(null)}
              onDragOver={(e) => { if (drag) e.preventDefault(); }}
              onDrop={(e) => { if (drag) { e.preventDefault(); e.stopPropagation(); move(drag, img.id); setDrag(null); } }}
              data-testid="media-item"
            >
              <img src={sizedImage(img.url, i === 0 ? 960 : 640)} alt={img.alt ?? ""} />
              {i === 0 ? <span className="media-tag badge neutral sm" style={{ background: "#fff" }}>Principal</span> : null}
              <div className="media-act">
                {i > 0 ? <button type="button" title="Hacer principal" aria-label="Hacer principal" onClick={() => move(img.id, order[0].id)}><Icon name="star" size={14} /></button> : null}
                <button type="button" title="Texto alternativo" aria-label="Editar texto alternativo" onClick={() => { setEdit(img); setAlt(img.alt ?? ""); }}><Icon name="eye" size={14} /></button>
                <button type="button" title="Eliminar" aria-label="Eliminar imagen" onClick={() => onRemove(img.id)}><Icon name="trash" size={14} /></button>
              </div>
            </div>
          ))}
          {pending.map((f, i) => (
            <div key={`p${i}`} className="media-item pending" title="Se subirá al guardar">
              <img src={URL.createObjectURL(f)} alt="" />
              <div className="media-act" style={{ display: "flex" }}>
                <button type="button" aria-label="Quitar" onClick={() => onPending(pending.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
              </div>
            </div>
          ))}
          <button type="button" className={`drop${over ? " over" : ""}`} style={{ aspectRatio: "1", cursor: "pointer", minHeight: 0 }} onClick={() => input.current?.click()} onDragLeave={() => setOver(false)} aria-label="Agregar imagen" disabled={busy}>
            <Icon name="plus" />
          </button>
        </div>
      )}
      {!productId && pending.length ? <p className="help">Las imágenes se subirán al guardar el programa.</p> : null}
      {urlOpen ? (
        <Modal
          title="Agregar imagen desde URL"
          onClose={() => setUrlOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setUrlOpen(false)}>Cancelar</button>
              <button type="button" className="btn btn-primary" disabled={!/^(https:\/\/|\/uploads\/)\S+$/.test(url) || !productId} onClick={() => { upload([], url); setUrl(""); setUrlOpen(false); }}>Agregar</button>
            </>
          }
        >
          <label className="field">
            <span>URL de la imagen</span>
            <input className="inp" type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
            <span className="help">{productId ? "Debe empezar por https:// (por ejemplo, del CDN actual de ceium.net)." : "Guarda el programa primero para agregar imágenes por URL."}</span>
          </label>
        </Modal>
      ) : null}
      {edit ? (
        <Modal
          title="Texto alternativo"
          onClose={() => setEdit(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEdit(null)}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={() => { const e = edit; setEdit(null); start(async () => { const r = await updateImageAltAction(productId!, e.id, alt); onMessage(r.ok ? "Texto alternativo guardado" : r.error, !r.ok); router.refresh(); }); }}>Guardar</button>
            </>
          }
        >
          <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
            <div className="thumb" style={{ width: 120, height: 120 }}><img src={sizedImage(edit.url, 320)} alt="" /></div>
            <label className="field" style={{ flex: 1 }}>
              <span>Texto alternativo</span>
              <textarea className="inp" value={alt} maxLength={300} onChange={(e) => setAlt(e.target.value)} />
              <span className="help">Describe la imagen para lectores de pantalla y buscadores.</span>
            </label>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

// ───────── Cursos del diplomado ─────────

export function CoursesCard({ courseIds, courses, onChange, error }: { courseIds: string[]; courses: EditorContext["courses"]; onChange: (ids: string[]) => void; error?: string }) {
  const [drag, setDrag] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [comboRef, comboOpen, setComboOpen] = useOutside<HTMLDivElement>();
  const byId = new Map(courses.map((c) => [c.id, c]));
  const available = courses.filter((c) => !courseIds.includes(c.id) && c.moodleCourseId != null && c.title.toLowerCase().includes(q.trim().toLowerCase()));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= courseIds.length || from === to) return;
    const n = [...courseIds];
    n.splice(to, 0, n.splice(from, 1)[0]);
    onChange(n);
  };
  return (
    <div className="card card-flush" id="sec-courses">
      <div className="card-h">
        <h2>Cursos del diplomado <span className="sub">· {courseIds.length}</span></h2>
      </div>
      <p className="muted" style={{ padding: "0 16px 12px" }}>Orden en que se cursan. Con «Paga mes a mes», cada cuota pagada matricula el siguiente curso de esta lista.</p>
      <div style={{ padding: "0 16px 12px" }}>
        <div className="combo" ref={comboRef}>
          <div className="ix-search" style={{ flex: "none" }}>
            <Icon name="search" />
            <input className="inp" placeholder="Buscar cursos para agregar" aria-label="Agregar curso al diplomado" value={q} onFocus={() => setComboOpen(true)} onChange={(e) => { setQ(e.target.value); setComboOpen(true); }} />
          </div>
          {comboOpen ? (
            <div className="popover" role="listbox" aria-label="Cursos disponibles">
              {available.length ? (
                available.map((c) => (
                  <button type="button" role="option" aria-selected={false} key={c.id} className="opt" onClick={() => { onChange([...courseIds, c.id]); setQ(""); setComboOpen(false); }}>
                    <span style={{ flex: 1 }}>{c.title}</span>
                    <span className="small muted">Moodle #{c.moodleCourseId}</span>
                  </button>
                ))
              ) : (
                <div className="ttl">No hay más cursos con curso de Moodle</div>
              )}
            </div>
          ) : null}
        </div>
      </div>
      {error ? <div className="banner critical" style={{ margin: "0 16px 12px" }}><Icon name="alert" /><span>{error}</span></div> : null}
      {courseIds.length ? (
        <ol className="sl" aria-label="Cursos del diplomado">
          {courseIds.map((id, i) => {
            const c = byId.get(id);
            return (
              <li
                key={id}
                draggable
                className={`${drag === i ? "dragging" : ""}${overIdx === i && drag !== null && drag !== i ? " over" : ""}`}
                onDragStart={() => setDrag(i)}
                onDragEnd={() => { setDrag(null); setOverIdx(null); }}
                onDragOver={(e) => { e.preventDefault(); setOverIdx(i); }}
                onDrop={(e) => { e.preventDefault(); if (drag !== null) move(drag, i); setDrag(null); setOverIdx(null); }}
                data-course-id={id}
              >
                <span className="handle" aria-hidden><Icon name="drag" size={16} /></span>
                <span className="pos">{i + 1}</span>
                <div className="name">
                  <Link href={`/admin/products/${id}`} className="strong">{c?.title ?? "Curso eliminado"}</Link>
                  <div className="small muted">{c?.moodleCourseId != null ? `Moodle #${c.moodleCourseId}` : "Sin curso de Moodle"}{c && c.status !== "ACTIVE" ? " · " : ""}{c && c.status !== "ACTIVE" ? <StatusBadge status={c.status} /> : null}</div>
                </div>
                <div className="acts">
                  <button type="button" className="btn btn-tertiary btn-icon" aria-label={`Subir ${c?.title}`} disabled={i === 0} onClick={() => move(i, i - 1)}><Icon name="chevronUp" size={16} /></button>
                  <button type="button" className="btn btn-tertiary btn-icon" aria-label={`Bajar ${c?.title}`} disabled={i === courseIds.length - 1} onClick={() => move(i, i + 1)}><Icon name="chevronDown" size={16} /></button>
                  <button type="button" className="btn btn-tertiary btn-icon" aria-label={`Quitar ${c?.title}`} onClick={() => onChange(courseIds.filter((x) => x !== id))}><Icon name="x" size={16} /></button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="ix-empty" style={{ paddingTop: 24 }}><p className="muted">Agrega los cursos que componen el diplomado.</p></div>
      )}
      <div className="card-foot">
        <span>{courseIds.length} {courseIds.length === 1 ? "curso" : "cursos"} · «Paga mes a mes» = {courseIds.length} {courseIds.length === 1 ? "cuota" : "cuotas"}</span>
        <span>Los pedidos ya hechos conservan su lista de cursos.</span>
      </div>
    </div>
  );
}

// ───────── Opciones de compra (p. ej. niveles de un taller) ─────────

export function ChoicesCard({ productId, choices, onMessage }: { productId: string; choices: ChoiceItem[]; onMessage: (t: string, err?: boolean) => void }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [editing, setEditing] = useState<{ id?: string; groupName: string; label: string; moodleCourseIds: string } | null>(null);
  const save = () => {
    if (!editing) return;
    const e = editing;
    start(async () => {
      const r = await saveChoiceAction({ ...e, productId });
      onMessage(r.ok ? "Opción guardada" : r.error, !r.ok);
      if (r.ok) setEditing(null);
      router.refresh();
    });
  };
  return (
    <div className="card card-flush" id="sec-choices">
      <div className="card-h">
        <h2>Opciones de compra</h2>
        <button type="button" className="btn btn-plain" onClick={() => setEditing({ groupName: choices[0]?.groupName ?? "Cursos disponibles", label: "", moodleCourseIds: "" })}>Agregar opción</button>
      </div>
      <p className="muted" style={{ padding: "0 16px 12px" }}>Para talleres por niveles: cada opción tiene sus propios precios en la matriz y matricula en sus cursos de Moodle.</p>
      {choices.length ? (
        <ul className="sl">
          {choices.map((c) => (
            <li key={c.id} style={{ paddingLeft: 16 }}>
              <div className="name">
                <span className="strong">{c.label}</span>
                <div className="small muted">{c.groupName} · {c.moodleCourseIds?.length ? `Moodle ${c.moodleCourseIds.map((x) => `#${x}`).join(", ")}` : "Curso de Moodle del programa"}</div>
              </div>
              <div className="acts">
                <button type="button" className="btn btn-tertiary" onClick={() => setEditing({ id: c.id, groupName: c.groupName, label: c.label, moodleCourseIds: (c.moodleCourseIds ?? []).join(", ") })}>Editar</button>
                <button type="button" className="btn btn-tertiary btn-icon" aria-label={`Eliminar ${c.label}`} disabled={busy} onClick={() => start(async () => { const r = await deleteChoiceAction(productId, c.id); onMessage(r.ok ? "Opción eliminada" : r.error, !r.ok); router.refresh(); })}><Icon name="trash" size={16} /></button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="subdued" style={{ padding: "0 16px 16px" }}>Sin opciones: se vende el programa completo.</p>
      )}
      {editing ? (
        <Modal
          title={editing.id ? "Editar opción" : "Agregar opción"}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancelar</button>
              <button type="button" className="btn btn-primary" disabled={busy || !editing.label.trim() || !editing.groupName.trim()} onClick={save}>Guardar</button>
            </>
          }
        >
          <div className="grid2">
            <label className="field"><span>Nombre del selector</span><input className="inp" value={editing.groupName} onChange={(e) => setEditing({ ...editing, groupName: e.target.value })} /></label>
            <label className="field"><span>Opción</span><input className="inp" value={editing.label} placeholder="Nivel 1" onChange={(e) => setEditing({ ...editing, label: e.target.value })} /></label>
          </div>
          <label className="field">
            <span>Cursos de Moodle</span>
            <input className="inp" value={editing.moodleCourseIds} placeholder="127, 128" onChange={(e) => setEditing({ ...editing, moodleCourseIds: e.target.value })} />
            <span className="help">IDs separados por coma. Vacío = el curso de Moodle del programa.</span>
          </label>
        </Modal>
      ) : null}
    </div>
  );
}
