"use client";
// Equipo (réplica de Configuración › Usuarios y permisos de Shopify): quién entra al panel, con qué rol y en qué estado.
// Invitar, cambiar nombre o rol, enviar un enlace para crear una contraseña nueva, quitar la verificación en dos
// pasos, desactivar o reactivar y cancelar invitaciones. Cada fila ofrece solo lo que el rol de quien mira puede
// hacer (el servidor lo vuelve a comprobar). La tabla de abajo resume qué puede hacer cada rol.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { AdminRole } from "@/generated/prisma/client";
import { ROLE_LABEL, ROLE_SUMMARY } from "@/server/admin-roles";
import type { TeamOverview } from "@/server/admin-users";
import {
  cancelInviteAction,
  inviteMemberAction,
  resetMemberTwoFactorAction,
  sendMemberLinkAction,
  setMemberActiveAction,
  updateMemberAction,
  type AccessLinkPayload,
  type TeamResult,
} from "@/app/admin/(panel)/team/actions";
import { Icon } from "../Icon";
import { Modal, useToast } from "../ui";

type Member = TeamOverview["users"][number];

const F = new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Caracas" });
const when = (d: Date | string | null) => (d ? F.format(new Date(d)) : "—");
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Qué puede hacer cada rol (lo mismo que auth.ts → PERMISSIONS, en palabras). true = sí · "view" = solo ver. */
const MATRIX: [string, [boolean | "view", boolean | "view", boolean | "view"]][] = [
  ["Pedidos: ver, notas, cancelar y reenviar correos", [true, true, true]],
  ["Verificar pagos manuales", [true, true, true]],
  ["Cohortes y matrículas", [true, true, true]],
  ["Programas, precios, colecciones y sedes", [true, true, "view"]],
  ["Revocar y volver a emitir certificados", [true, true, false]],
  ["Invitar y gestionar asistentes", [true, true, false]],
  ["Gestionar administradores comerciales y super administradores", [true, false, false]],
  ["Reembolsos, ajustes de saldo y aprobar un pago por más de lo calculado", [true, false, false]],
  ["Configuración: métodos de pago, PayPal, tasa, reservas y seguridad", [true, "view", "view"]],
];
const MATRIX_ROLES: AdminRole[] = ["ADMIN", "COMMERCIAL", "STAFF"];
/** Encabezados cortos de la tabla en el teléfono. */
const SHORT: Record<AdminRole, string> = { ADMIN: "Super", COMMERCIAL: "Comercial", STAFF: "Asistente" };

function status(m: Member): { label: string; tone: string } {
  if (!m.active) return { label: "Desactivado", tone: "neutral" };
  if (m.invitePending) return m.inviteExpired ? { label: "Invitación vencida", tone: "critical" } : { label: "Invitación pendiente", tone: "attention" };
  if (m.locked) return { label: "Bloqueado unos minutos", tone: "critical" };
  return { label: "Activo", tone: "success" };
}

function RolePicker({ roles, value, onChange, name }: { roles: AdminRole[]; value: AdminRole; onChange: (r: AdminRole) => void; name: string }) {
  return (
    <div className="xp-group" role="radiogroup" aria-labelledby={`${name}-h`}>
      <div className="xp-h" id={`${name}-h`}>Rol</div>
      {roles.map((r) => (
        <label key={r} className="xp-radio">
          <input type="radio" name={name} value={r} checked={value === r} onChange={() => onChange(r)} />
          <span>
            {ROLE_LABEL[r]}
            <span className="help" style={{ display: "block" }}>{ROLE_SUMMARY[r]}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** El enlace recién generado: se muestra una sola vez (no se guarda en ningún lado). */
function AccessLinkBox({ access }: { access: AccessLinkPayload }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(access.link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="tm-link">
      {access.emailed ? (
        <p>Le enviamos el enlace por correo a <b>{access.email}</b>. Si no le llega, cópialo y compártelo por WhatsApp.</p>
      ) : (
        <div className="banner attention" role="status"><Icon name="alert" /><span>No pudimos enviar el correo a {access.email}. Copia el enlace y compártelo tú.</span></div>
      )}
      <div className="tm-link-row">
        <input className="inp" readOnly value={access.link} aria-label="Enlace de acceso" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn" onClick={copy}><Icon name="duplicate" size={16} /> {copied ? "Copiado" : "Copiar"}</button>
      </div>
      <p className="small muted">
        Vence el {when(access.expiresAt)} y sirve una sola vez. Compártelo solo con {access.name}: quien lo abra puede {access.kind === "invite" ? "crear la contraseña de esta cuenta" : "cambiar la contraseña de esta cuenta"}. No podrás volver a verlo; si se pierde, genera otro.
      </p>
    </div>
  );
}

type Confirm = "deactivate" | "reset2fa" | "cancelInvite";
const CONFIRM_COPY: Record<Confirm, { title: (n: string) => string; body: (n: string) => string; cta: string }> = {
  deactivate: {
    title: (n) => `¿Desactivar a ${n}?`,
    body: () => "Se cierran sus sesiones al instante y ya no podrá entrar al panel. Su nombre se mantiene en el historial de pedidos y pagos. Puedes reactivar la cuenta cuando quieras.",
    cta: "Desactivar acceso",
  },
  reset2fa: {
    title: () => "¿Quitar la verificación en dos pasos?",
    body: (n) => `Hazlo solo si ${n} perdió el teléfono y sus códigos de recuperación, y confirmaste que es esa persona quien te lo pide. Se cierran sus sesiones y al entrar solo le pedirán la contraseña hasta que la configure de nuevo. Le avisaremos por correo.`,
    cta: "Quitar verificación",
  },
  cancelInvite: {
    title: (n) => `¿Cancelar la invitación de ${n}?`,
    body: () => "El enlace deja de servir y la cuenta se elimina (nunca llegó a entrar). Puedes volver a invitar a esa persona más adelante.",
    cta: "Cancelar invitación",
  },
};

export function TeamView({ data, require2fa }: { data: TeamOverview; require2fa: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ name: string; email: string; role: AdminRole; tried: boolean } | null>(null);
  const [manage, setManage] = useState<{ member: Member; name: string; role: AdminRole; confirm: Confirm | null } | null>(null);
  const [access, setAccess] = useState<AccessLinkPayload | null>(null);

  const me = data.me;
  const canInvite = data.assignable.length > 0;
  const defaultRole: AdminRole = data.assignable.find((r) => r !== "ADMIN") ?? data.assignable[0] ?? "STAFF";
  const active = data.users.filter((u) => u.active && !u.invitePending).length;
  const pendingInvites = data.users.filter((u) => u.active && u.invitePending).length;

  function run<T>(fn: () => Promise<TeamResult<T>>, done: (r: { ok: true; message: string } & T) => void) {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      done(r);
      router.refresh();
    });
  }

  const inviteErrors = invite
    ? { name: !invite.name.trim() ? "Escribe el nombre." : null, email: !EMAIL_RE.test(invite.email.trim()) ? "Escribe un correo válido." : null }
    : { name: null, email: null };

  const openManage = (m: Member) => {
    setError(null);
    setManage({ member: m, name: m.name, role: m.role, confirm: null });
  };
  const changed = manage ? manage.name.trim() !== manage.member.name || manage.role !== manage.member.role : false;
  // El rol actual siempre aparece (aunque quien mira no pudiera asignarlo, no llega aquí: solo gestiona roles menores).
  const manageRoles = manage ? Array.from(new Set<AdminRole>([...data.assignable, manage.member.role])) : [];

  return (
    <>
      <div className="adm-ph">
        <div className="grow">
          <h1>Equipo</h1>
          <div className="meta">
            {active} {active === 1 ? "persona con acceso" : "personas con acceso"} al panel{pendingInvites ? ` · ${pendingInvites} ${pendingInvites === 1 ? "invitación pendiente" : "invitaciones pendientes"}` : ""}
          </div>
        </div>
        {canInvite ? (
          <div className="adm-ph-actions">
            <button type="button" className="btn btn-primary" onClick={() => { setError(null); setInvite({ name: "", email: "", role: defaultRole, tried: false }); }}>Invitar persona</button>
          </div>
        ) : null}
      </div>

      {me.role !== "ADMIN" ? (
        <div className="banner info" role="status">
          <Icon name="info" />
          <span>Como {ROLE_LABEL[me.role].toLowerCase()} puedes invitar y gestionar asistentes. A los administradores los gestiona el super administrador.</span>
        </div>
      ) : null}

      <section className="card card-flush" aria-labelledby="h-team">
        <div className="card-h">
          <h2 id="h-team">Personas</h2>
          {require2fa ? <span className="small muted">Verificación en dos pasos obligatoria para todos</span> : null}
        </div>
        <ul className="tm-list" aria-label="Personas del equipo">
          {data.users.map((m) => {
            const st = status(m);
            return (
              <li key={m.id} className={m.active ? undefined : "off"} data-member={m.email}>
                <span className="tm-avatar" aria-hidden>{initials(m.name)}</span>
                <div className="tm-main">
                  <div className="t">
                    <span className="nm">{m.name}</span>
                    {m.me ? <span className="badge info sm">Tú</span> : null}
                    <span className="badge sm" data-role={m.role}>{ROLE_LABEL[m.role]}</span>
                  </div>
                  <div className="s">{m.email}</div>
                  <div className="s">
                    <span className={`badge sm ${st.tone}`} data-status={st.label}>{st.label}</span>
                    {m.active && !m.invitePending ? (
                      <>
                        {" "}
                        {m.twoFactor ? <span className="tm-2fa on"><Icon name="shield" size={14} /> Dos pasos</span> : <span className={`tm-2fa${require2fa ? " warn" : ""}`}>Sin verificación en dos pasos</span>}
                        {" · "}
                        {m.lastLoginAt ? `Último acceso ${when(m.lastLoginAt)}` : "Nunca ha entrado"}
                      </>
                    ) : m.invitePending && m.active ? (
                      ` · invitada el ${when(m.createdAt)}`
                    ) : null}
                  </div>
                </div>
                <div className="tm-acts">
                  {m.me ? (
                    <Link className="btn" href="/admin/account">Mi cuenta</Link>
                  ) : m.manageable ? (
                    <button type="button" className="btn" aria-label={`Gestionar a ${m.name}`} onClick={() => openManage(m)}>Gestionar</button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card card-flush" aria-labelledby="h-roles" style={{ marginTop: 16 }}>
        <div className="card-h"><h2 id="h-roles">Qué puede hacer cada rol</h2></div>
        <div style={{ overflowX: "auto" }}>
          <table className="tm-matrix" aria-labelledby="h-roles">
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">Permiso</span></th>
                {MATRIX_ROLES.map((r) => (
                  <th key={r} scope="col">
                    <span className="lg">{ROLE_LABEL[r]}</span>
                    <span className="sm" aria-hidden>{SHORT[r]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MATRIX.map(([what, v]) => (
                <tr key={what}>
                  <th scope="row">{what}</th>
                  {v.map((x, i) => (
                    <td key={MATRIX_ROLES[i]}>
                      {x === true ? <Icon name="check" size={18} className="yes" title="Sí" /> : x === "view" ? <span className="view">Solo ver</span> : <span className="no" aria-label="No">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p className="muted" style={{ textAlign: "center", marginTop: 20, padding: "0 16px" }}>Las cuentas no se borran: al desactivarlas se conserva quién verificó cada pago. Cada cambio queda en la auditoría y se avisa por correo a la persona.</p>

      {invite ? (
        <Modal
          title="Invitar persona"
          onClose={() => setInvite(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setInvite(null)}>Cancelar</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={pending}
                onClick={() => {
                  setInvite({ ...invite, tried: true });
                  if (inviteErrors.name || inviteErrors.email) return;
                  run(() => inviteMemberAction({ name: invite.name.trim(), email: invite.email.trim(), role: invite.role }), (r) => { setInvite(null); setAccess(r.access); });
                }}
              >
                {pending ? "Enviando…" : "Enviar invitación"}
              </button>
            </>
          }
        >
          {error ? <div className="banner critical" role="alert"><Icon name="alert" /><span>{error}</span></div> : null}
          <div className="grid2">
            <label className="field">
              <span>Nombre</span>
              <input className="inp" value={invite.name} autoFocus autoComplete="off" aria-invalid={invite.tried && !!inviteErrors.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
              {invite.tried && inviteErrors.name ? <span className="field-err">{inviteErrors.name}</span> : null}
            </label>
            <label className="field">
              <span>Correo electrónico</span>
              <input className="inp" type="email" value={invite.email} autoComplete="off" aria-invalid={invite.tried && !!inviteErrors.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
              {invite.tried && inviteErrors.email ? <span className="field-err">{inviteErrors.email}</span> : null}
            </label>
          </div>
          <RolePicker name="invite-role" roles={data.assignable} value={invite.role} onChange={(role) => setInvite({ ...invite, role })} />
          <p className="small muted" style={{ marginTop: 16 }}>Le enviaremos un correo con un enlace para crear su contraseña (vence en 72 horas). También podrás copiarlo para compartirlo tú.</p>
        </Modal>
      ) : null}

      {manage ? (
        <Modal
          title={manage.confirm ? CONFIRM_COPY[manage.confirm].title(manage.member.name) : manage.member.name}
          onClose={() => setManage(null)}
          footer={
            manage.confirm ? (
              <>
                <button type="button" className="btn" onClick={() => { setError(null); setManage({ ...manage, confirm: null }); }}>Volver</button>
                <button
                  type="button"
                  className="btn btn-critical"
                  disabled={pending}
                  onClick={() => {
                    const id = manage.member.id;
                    const act = manage.confirm === "deactivate" ? () => setMemberActiveAction(id, false) : manage.confirm === "reset2fa" ? () => resetMemberTwoFactorAction(id) : () => cancelInviteAction(id);
                    run(act, (r) => { setManage(null); toast.show(r.message); });
                  }}
                >
                  {CONFIRM_COPY[manage.confirm].cta}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn" onClick={() => setManage(null)}>Cerrar</button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={pending || !changed || !manage.name.trim()}
                  onClick={() => run(() => updateMemberAction(manage.member.id, { ...(manage.name.trim() !== manage.member.name ? { name: manage.name.trim() } : {}), ...(manage.role !== manage.member.role ? { role: manage.role } : {}) }), (r) => { setManage(null); toast.show(r.message); })}
                >
                  Guardar
                </button>
              </>
            )
          }
        >
          {error ? <div className="banner critical" role="alert"><Icon name="alert" /><span>{error}</span></div> : null}
          {manage.confirm ? (
            <p>{CONFIRM_COPY[manage.confirm].body(manage.member.name)}</p>
          ) : (
            <>
              <p className="small muted" style={{ margin: "0 0 12px" }}>{manage.member.email}</p>
              <label className="field">
                <span>Nombre</span>
                <input className="inp" value={manage.name} onChange={(e) => setManage({ ...manage, name: e.target.value })} disabled={!manage.member.active} />
              </label>
              {manage.member.active ? <RolePicker name="manage-role" roles={manageRoles} value={manage.role} onChange={(role) => setManage({ ...manage, role })} /> : null}
              {manage.role !== manage.member.role && !manage.member.invitePending ? <p className="small muted" style={{ marginTop: 8 }}>Al cambiar el rol se cierran sus sesiones y le avisamos por correo.</p> : null}

              <div className="tm-access">
                <div className="xp-h">Acceso</div>
                {!manage.member.active ? (
                  <div className="tm-access-row">
                    <div><b>Cuenta desactivada</b><span className="help">No puede entrar al panel.</span></div>
                    <button type="button" className="btn" disabled={pending} onClick={() => run(() => setMemberActiveAction(manage.member.id, true), (r) => { setManage(null); toast.show(r.message); })}>Reactivar acceso</button>
                  </div>
                ) : manage.member.invitePending ? (
                  <>
                    <div className="tm-access-row">
                      <div><b>{manage.member.inviteExpired ? "La invitación venció" : "Todavía no creó su contraseña"}</b><span className="help">Un enlace nuevo anula el anterior.</span></div>
                      <button type="button" className="btn" disabled={pending} onClick={() => run(() => sendMemberLinkAction(manage.member.id), (r) => { setManage(null); setAccess(r.access); })}>Reenviar invitación</button>
                    </div>
                    <div className="tm-access-row">
                      <div><b>Cancelar invitación</b><span className="help">La cuenta se elimina; nunca llegó a entrar.</span></div>
                      <button type="button" className="btn btn-plain critical" onClick={() => { setError(null); setManage({ ...manage, confirm: "cancelInvite" }); }}>Cancelar invitación</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="tm-access-row">
                      <div><b>Contraseña</b><span className="help">Si la olvidó: un enlace para crear una nueva (24 h). La actual sigue sirviendo hasta que la cambie.</span></div>
                      <button type="button" className="btn" disabled={pending} onClick={() => run(() => sendMemberLinkAction(manage.member.id), (r) => { setManage(null); setAccess(r.access); })}>Enviar enlace</button>
                    </div>
                    {manage.member.twoFactor ? (
                      <div className="tm-access-row">
                        <div><b>Verificación en dos pasos</b><span className="help">Si perdió el teléfono y sus códigos de recuperación.</span></div>
                        <button type="button" className="btn" onClick={() => { setError(null); setManage({ ...manage, confirm: "reset2fa" }); }}>Quitar verificación</button>
                      </div>
                    ) : null}
                    <div className="tm-access-row">
                      <div><b>Desactivar acceso</b><span className="help">Cierra sus sesiones y ya no podrá entrar. Se puede revertir.</span></div>
                      <button type="button" className="btn btn-plain critical" onClick={() => { setError(null); setManage({ ...manage, confirm: "deactivate" }); }}>Desactivar acceso</button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </Modal>
      ) : null}

      {access ? (
        <Modal
          title={access.kind === "invite" ? "Invitación lista" : "Enlace para crear contraseña nueva"}
          onClose={() => setAccess(null)}
          footer={<button type="button" className="btn btn-primary" onClick={() => setAccess(null)}>Listo</button>}
        >
          <AccessLinkBox access={access} />
        </Modal>
      ) : null}
      {toast.node}
    </>
  );
}
