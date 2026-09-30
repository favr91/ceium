"use client";
// Tienda en línea › Quiénes somos: la sección «Personal de CEIUM» de /pages/quienes-somos. Quién aparece (mostrar u
// ocultar sin borrar), en qué orden (arrastrar o flechas), nombre, cargo y foto, y el título y el texto de la
// sección. Todo se edita en un borrador y se publica junto con «Guardar» en la barra superior, como la ficha de
// un programa; la foto se sube (y optimiza) al elegirla y queda en el borrador hasta guardar.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { saveTeamAction, uploadTeamPhotoAction } from "@/app/admin/(panel)/pages/quienes-somos/actions";
import { sizedImage } from "@/components/store/image-url";
import type { TeamMember, TeamSection } from "@/components/store/pages/team";
import type { TeamEditorData } from "@/server/about-team";
import { Icon } from "../Icon";
import { MAX_UPLOAD_BYTES, shrinkPhoto } from "../products/parts";
import { Modal, useToast } from "../ui";
import "./pages.css";

const STORE_URL = "/pages/quienes-somos";
const newId = (taken: TeamMember[]) => {
  for (;;) {
    const id = `p-${Math.random().toString(36).slice(2, 10)}`;
    if (!taken.some((m) => m.id === id)) return id;
  }
};
const initials = (name: string) =>
  name
    .replace(/^(dra?|lic(d[oa])?|ing|prof|msc|abg)\.\s*/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

function Photo({ member, size }: { member: Pick<TeamMember, "name" | "photo">; size: number }) {
  return member.photo ? (
    // eslint-disable-next-line @next/next/no-img-element -- CDN de Shopify o /uploads (ya en el ancho justo)
    <img className="ab-photo" src={sizedImage(member.photo, size * 2)} alt="" width={size} height={size} style={{ width: size, height: size }} />
  ) : (
    <span className="ab-photo ab-photo--empty" style={{ width: size, height: size }} aria-hidden>
      {initials(member.name) || <Icon name="image" size={size > 60 ? 24 : 18} />}
    </span>
  );
}

interface Editing {
  member: TeamMember;
  isNew: boolean;
  /** Nombre antes de editar (título del diálogo). */
  was: string;
}

export function AboutTeamEditor({ data, canEdit }: { data: TeamEditorData; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [saving, startSave] = useTransition();
  const [base, setBase] = useState<TeamSection>(data.team);
  const [version, setVersion] = useState(data.version);
  const [draft, setDraft] = useState<TeamSection>(data.team);
  const [drag, setDrag] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [edit, setEdit] = useState<Editing | null>(null);
  const [tried, setTried] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [photoErr, setPhotoErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const members = draft.members;
  const visible = members.filter((m) => !m.hidden).length;
  const setMembers = (fn: (ms: TeamMember[]) => TeamMember[]) => setDraft((d) => ({ ...d, members: fn(d.members) }));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= members.length || from === to) return;
    setMembers((ms) => {
      const n = [...ms];
      n.splice(to, 0, n.splice(from, 1)[0]);
      return n;
    });
  };
  const toggle = (id: string, show: boolean) => setMembers((ms) => ms.map((m) => (m.id === id ? { ...m, hidden: show ? undefined : true } : m)));

  const titleErr = !draft.title.trim() ? "El título de la sección es obligatorio." : null;
  const missingPhoto = members.filter((m) => !m.hidden && !m.photo);

  const save = () => {
    if (titleErr) return toast.show(titleErr, true);
    if (missingPhoto.length) return toast.show(`Falta la foto de ${missingPhoto.map((m) => m.name).join(", ")}: súbela u oculta a esa persona.`, true);
    startSave(async () => {
      const r = await saveTeamAction(draft, version).catch(() => ({ ok: false as const, error: "No se pudo enviar (revisa la conexión)." }));
      if (!r.ok) return toast.show(r.error, true);
      setBase(r.team);
      setDraft(r.team);
      setVersion(r.version);
      toast.show("Cambios publicados");
      router.refresh();
    });
  };

  // ───── Diálogo de una persona ─────
  const open = (m?: TeamMember) => {
    setTried(false);
    setPhotoErr(null);
    setEdit(m ? { member: { ...m }, isNew: false, was: m.name } : { member: { id: newId(members), name: "", role: "", photo: "" }, isNew: true, was: "" });
  };
  const setField = (patch: Partial<TeamMember>) => setEdit((e) => e && { ...e, member: { ...e.member, ...patch } });
  const nameErr = edit && !edit.member.name.trim() ? "El nombre es obligatorio." : null;
  const apply = () => {
    if (!edit) return;
    setTried(true);
    if (nameErr) return;
    const m = { ...edit.member, name: edit.member.name.trim(), role: edit.member.role.trim() };
    setMembers((ms) => (edit.isNew ? [...ms, m] : ms.map((x) => (x.id === m.id ? m : x))));
    setEdit(null);
  };
  const remove = () => {
    if (!edit) return;
    setMembers((ms) => ms.filter((x) => x.id !== edit.member.id));
    setEdit(null);
  };
  const upload = async (f: File | undefined) => {
    if (!f || !edit) return;
    setPhotoErr(null);
    setUploading(true);
    try {
      const file = await shrinkPhoto(f);
      if (file.size > MAX_UPLOAD_BYTES) return setPhotoErr("La foto pesa más de 10 MB.");
      const fd = new FormData();
      fd.set("file", file);
      fd.set("name", edit.member.name);
      const r = await uploadTeamPhotoAction(fd).catch(() => ({ ok: false as const, error: "No se pudo enviar (revisa la conexión)." }));
      if (r.ok) setField({ photo: r.url });
      else setPhotoErr(r.error);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <>
      {dirty && canEdit ? (
        <div className="savebar" role="region" aria-label="Cambios sin guardar">
          <div className="savebar-in">
            <div className="msg"><Icon name="alert" size={18} /> <span>Cambios sin publicar</span></div>
            <button type="button" className="btn btn-dark" onClick={() => setDraft(base)} disabled={saving}>Descartar</button>
            <button type="button" className="btn btn-save" onClick={save} disabled={saving}>{saving ? "Guardando…" : "Guardar"}</button>
          </div>
        </div>
      ) : null}

      <div className="adm-page">
        <div className="adm-ph">
          <div className="grow">
            <h1>Quiénes somos</h1>
            <div className="meta">Personal que muestra la página · {visible} de {members.length} {members.length === 1 ? "persona visible" : "personas visibles"}</div>
          </div>
          <div className="adm-ph-actions">
            <a className="btn btn-gray hide-sm" href={STORE_URL} target="_blank" rel="noreferrer">Ver en la tienda</a>
            {canEdit ? <button type="button" className="btn btn-primary" onClick={() => open()}>Agregar persona</button> : null}
          </div>
        </div>
        {!canEdit ? <div className="banner info" role="status"><Icon name="info" /><span>Como asistente puedes ver el personal de la página; editarlo es del administrador comercial o del superadministrador.</span></div> : null}

        <section className="card" aria-labelledby="h-ab-head">
          <div className="card-h"><h2 id="h-ab-head">Encabezado de la sección</h2></div>
          <label className="field">
            <span>Título</span>
            <input className="inp" aria-label="Título de la sección" value={draft.title} disabled={!canEdit} maxLength={120} aria-invalid={!!titleErr} onChange={(e) => { const v = e.target.value; setDraft((d) => ({ ...d, title: v })); }} />
            {titleErr ? <span className="field-err">{titleErr}</span> : null}
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Texto</span>
            <textarea className="inp" aria-label="Texto de la sección" rows={3} value={draft.text} disabled={!canEdit} maxLength={600} onChange={(e) => { const v = e.target.value; setDraft((d) => ({ ...d, text: v })); }} />
          </label>
        </section>

        <section className="card card-flush" aria-labelledby="h-ab-people">
          <div className="card-h">
            <h2 id="h-ab-people">Personas <span className="sub">· {members.length}</span></h2>
          </div>
          <p className="muted" style={{ padding: "0 16px 12px", margin: 0 }}>
            {canEdit ? "Aparecen en este orden. Arrastra o usa las flechas para cambiarlo. Las personas ocultas no se ven en la tienda, pero siguen aquí para volver a mostrarlas." : "Aparecen en este orden. Las personas ocultas no se ven en la tienda."}
          </p>
          {members.length ? (
            <ol className="sl ab-people" aria-label="Personal">
              {members.map((m, i) => (
                <li
                  key={m.id}
                  data-person={m.id}
                  draggable={canEdit}
                  className={`${m.hidden ? "off" : ""}${drag === i ? " dragging" : ""}${overIdx === i && drag !== null && drag !== i ? " over" : ""}`}
                  onDragStart={() => setDrag(i)}
                  onDragEnd={() => { setDrag(null); setOverIdx(null); }}
                  onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setOverIdx(i); } }}
                  onDrop={(e) => { e.preventDefault(); if (drag !== null) move(drag, i); setDrag(null); setOverIdx(null); }}
                >
                  {canEdit ? <span className="handle hide-sm" aria-hidden><Icon name="drag" size={16} /></span> : null}
                  <span className="pos hide-sm">{i + 1}</span>
                  <Photo member={m} size={40} />
                  <div className="name">
                    <div className="ab-name">
                      {canEdit ? <button type="button" className="ab-name-btn" onClick={() => open(m)}>{m.name}</button> : <span className="strong">{m.name}</span>}
                      {m.hidden ? <span className="badge sm">Oculta</span> : !m.photo ? <span className="badge sm critical">Sin foto</span> : null}
                    </div>
                    <div className="small muted ab-role">{m.role || "Sin cargo"}</div>
                  </div>
                  {canEdit ? (
                    <div className="acts">
                      <button type="button" className="btn btn-tertiary btn-icon" aria-label={`Subir a ${m.name}`} disabled={i === 0} onClick={() => move(i, i - 1)}><Icon name="chevronUp" size={16} /></button>
                      <button type="button" className="btn btn-tertiary btn-icon" aria-label={`Bajar a ${m.name}`} disabled={i === members.length - 1} onClick={() => move(i, i + 1)}><Icon name="chevronDown" size={16} /></button>
                      <input type="checkbox" className="toggle ab-toggle" role="switch" aria-label={`Mostrar a ${m.name} en la tienda`} title={m.hidden ? "Oculta en la tienda" : "Visible en la tienda"} checked={!m.hidden} onChange={(e) => toggle(m.id, e.target.checked)} />
                      <button type="button" className="btn hide-sm" aria-label={`Editar a ${m.name}`} onClick={() => open(m)}>Editar</button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <div className="ix-empty"><Icon name="team" size={40} /><h3>Sin personas</h3><p className="muted">La sección no se muestra en la tienda hasta que agregues a alguien.</p></div>
          )}
          <div className="card-foot">
            <span>{visible} {visible === 1 ? "visible" : "visibles"} · {members.length - visible} {members.length - visible === 1 ? "oculta" : "ocultas"}</span>
            <span>Los cambios se publican al guardar.</span>
          </div>
        </section>
      </div>

      {edit ? (
        <Modal
          title={edit.isNew ? "Agregar persona" : `Editar a ${edit.was}`}
          onClose={() => !uploading && setEdit(null)}
          footer={
            <>
              {!edit.isNew ? <button type="button" className="btn btn-plain critical" style={{ marginRight: "auto" }} onClick={remove} disabled={uploading}>Quitar de la página</button> : null}
              <button type="button" className="btn" onClick={() => setEdit(null)} disabled={uploading}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={apply} disabled={uploading}>{edit.isNew ? "Agregar" : "Listo"}</button>
            </>
          }
        >
          <div className="ab-photo-field">
            <Photo member={edit.member} size={96} />
            <div style={{ minWidth: 0 }}>
              <div className="ab-photo-btns">
                <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={uploading}><Icon name="upload" size={16} /> {edit.member.photo ? "Cambiar foto" : "Subir foto"}</button>
                {edit.member.photo ? <button type="button" className="btn btn-plain" onClick={() => setField({ photo: "" })} disabled={uploading}>Quitar foto</button> : null}
              </div>
              <span className="help" role={uploading ? "status" : undefined}>{uploading ? "Subiendo y optimizando…" : "JPG, PNG o WEBP de hasta 10 MB. Se muestra cuadrada y recortada al centro."}</span>
              {photoErr ? <span className="field-err" role="alert">{photoErr}</span> : null}
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" hidden aria-label="Foto" onChange={(e) => void upload(e.target.files?.[0])} />
            </div>
          </div>
          <label className="field">
            <span>Nombre</span>
            <input className="inp" aria-label="Nombre" value={edit.member.name} maxLength={120} autoFocus aria-invalid={tried && !!nameErr} onChange={(e) => setField({ name: e.target.value })} />
            {tried && nameErr ? <span className="field-err">{nameErr}</span> : <span className="help">Con su título, tal como se muestra: «Dra. Mireya Montes de Oca».</span>}
          </label>
          <label className="field">
            <span>Cargo</span>
            <input className="inp" aria-label="Cargo" value={edit.member.role} maxLength={160} placeholder="Coordinadora académica" onChange={(e) => setField({ role: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" aria-label="Mostrar en la tienda" checked={!edit.member.hidden} onChange={(e) => setField({ hidden: e.target.checked ? undefined : true })} />
            <span className="t">Mostrar en la tienda<span className="d">Si la ocultas, sigue en esta lista para volver a mostrarla cuando quieras.</span></span>
          </label>
          {!edit.member.hidden && !edit.member.photo ? <div className="banner attention" style={{ marginTop: 12, marginBottom: 0 }} role="note"><Icon name="alert" /><span>Sube una foto para mostrar a esta persona en la tienda, u ocúltala mientras tanto.</span></div> : null}
        </Modal>
      ) : null}
      {toast.node}
    </>
  );
}
