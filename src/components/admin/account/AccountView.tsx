"use client";
// «Mi cuenta»: verificación en dos pasos (activar con QR, códigos de recuperación, desactivar), contraseña,
// sesiones abiertas y equipos recordados. Todo actúa solo sobre el usuario de la sesión.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { AccountOverview } from "@/server/admin-account";
import { ROLE_LABEL } from "@/server/admin-roles";
import {
  beginTwoFactorAction,
  changePasswordAction,
  confirmTwoFactorAction,
  disableTwoFactorAction,
  forgetDevicesAction,
  regenerateCodesAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
  type AccountResult,
} from "@/app/admin/(account)/account/actions";
import { Icon } from "../Icon";
import { Modal, useToast } from "../ui";

const F = new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Caracas" });
const when = (d: Date | string | null) => (d ? F.format(new Date(d)) : "—");

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const text = `Códigos de recuperación del panel de CEIUM\nCada código sirve una sola vez para entrar sin el teléfono.\n\n${codes.join("\n")}\n`;
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    a.download = "codigos-recuperacion-ceium.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="acc-codes" data-testid="recovery-codes">
      <div className="banner attention" role="status">
        <Icon name="alert" />
        <span>
          <b>Guarda estos códigos ahora: no se vuelven a mostrar.</b> Si pierdes el teléfono, cada uno te deja entrar una vez. Descárgalos o imprímelos y guárdalos fuera del teléfono.
        </span>
      </div>
      <ol className="acc-code-list">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="btn-group" style={{ flexWrap: "wrap" }}>
        <button type="button" className="btn" onClick={download}><Icon name="download" size={16} /> Descargar (.txt)</button>
        <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(text)}><Icon name="duplicate" size={16} /> Copiar</button>
      </div>
      <label className="check" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span className="t">Guardé mis códigos en un lugar seguro</span>
      </label>
      <button type="button" className="btn btn-primary" disabled={!saved} onClick={onDone} style={{ marginTop: 8 }}>Listo</button>
    </div>
  );
}

export function AccountView({ data, prompt, recoveryLeft }: { data: AccountOverview; prompt: boolean; recoveryLeft: number | null }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [setup, setSetup] = useState<{ qr: string; manualKey: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [modal, setModal] = useState<null | "disable" | "regenerate">(null);
  const [pw, setPw] = useState({ password: "", code: "" });
  const [pwForm, setPwForm] = useState({ current: "", next: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const tf = data.twoFactor;

  // `inline`: el error se muestra junto al campo (activación, diálogos); si no, en un aviso flotante.
  const run = <T,>(fn: () => Promise<AccountResult<T>>, then?: (r: { ok: true } & T) => void, inline = false) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) {
        if (inline) setError(r.error);
        else toast.show(r.error, true);
        return;
      }
      if (r.message) toast.show(r.message);
      then?.(r);
      router.refresh();
    });

  const pwMismatch = pwForm.confirm.length > 0 && pwForm.next !== pwForm.confirm;

  return (
    <div className="adm-page acc">
      <div className="adm-ph">
        <div className="grow">
          <h1>Mi cuenta</h1>
          <div className="meta">{data.user.name} · {data.user.email} · {ROLE_LABEL[data.user.role]}</div>
        </div>
      </div>

      {prompt && tf.required && !tf.enabled ? (
        <div className="banner attention" role="alert">
          <Icon name="alert" />
          <span><b>El equipo exige la verificación en dos pasos.</b> Actívala aquí para seguir usando el panel.</span>
        </div>
      ) : null}
      {recoveryLeft != null ? (
        <div className={`banner ${recoveryLeft <= 3 ? "attention" : "info"}`} role="status">
          <Icon name="alert" />
          <span>
            Entraste con un código de recuperación: te {recoveryLeft === 1 ? "queda 1" : `quedan ${recoveryLeft}`}. Si perdiste el teléfono, desactiva la verificación y vuelve a activarla con el teléfono nuevo, o genera códigos nuevos.
          </span>
        </div>
      ) : null}

      {/* Verificación en dos pasos */}
      <section className="card" aria-labelledby="h-2fa" id="dos-pasos">
        <div className="card-h">
          <h2 id="h-2fa">Verificación en dos pasos</h2>
          <span className={`badge ${tf.enabled ? "success" : "attention"}`} data-testid="2fa-status">{tf.enabled ? "Activada" : "Desactivada"}</span>
        </div>
        <p className="muted acc-p">
          Además de la contraseña, al iniciar sesión se pide un código de 6 dígitos que genera una app en tu teléfono (Google Authenticator, Microsoft Authenticator, Authy o 1Password). Si alguien consigue tu contraseña, igual no puede entrar.
        </p>

        {codes ? (
          <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
        ) : tf.enabled ? (
          <>
            <dl className="acc-kv">
              <dt>Activada</dt>
              <dd>{when(tf.enabledAt)}</dd>
              <dt>Códigos de recuperación</dt>
              <dd className={tf.recoveryLeft <= 3 ? "attn" : undefined}>{tf.recoveryLeft === 1 ? "Queda 1 sin usar" : `Quedan ${tf.recoveryLeft} sin usar`}</dd>
            </dl>
            <div className="btn-group" style={{ flexWrap: "wrap" }}>
              <button type="button" className="btn" onClick={() => { setPw({ password: "", code: "" }); setError(null); setModal("regenerate"); }}>Generar códigos nuevos</button>
              <button type="button" className="btn btn-plain critical" onClick={() => { setPw({ password: "", code: "" }); setError(null); setModal("disable"); }}>Desactivar</button>
            </div>
          </>
        ) : setup ? (
          <div className="acc-setup">
            <ol className="acc-steps">
              <li>
                <b>Escanea el código QR</b> con la app autenticadora de tu teléfono (en la app: «Agregar» o «+», y luego «Escanear código QR»).
                <div className="acc-qr">
                  {/* eslint-disable-next-line @next/next/no-img-element -- QR generado en el servidor (data URL) */}
                  <img src={setup.qr} alt="Código QR para la app autenticadora" width={200} height={200} data-testid="2fa-qr" />
                  <div className="small muted">
                    ¿No puedes escanearlo? Escribe esta clave en la app:
                    <code className="acc-key" data-testid="2fa-key">{setup.manualKey}</code>
                  </div>
                </div>
              </li>
              <li>
                <b>Escribe el código de 6 dígitos</b> que muestra la app para CEIUM:
                <form
                  className="acc-inline"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(() => confirmTwoFactorAction(code), (r) => { setCodes(r.recoveryCodes); setSetup(null); setCode(""); }, true);
                  }}
                >
                  <input className="inp acc-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123 456" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Código de verificación" required />
                  <button type="submit" className="btn btn-primary" disabled={pending || code.replace(/\D/g, "").length !== 6}>Activar</button>
                  <button type="button" className="btn btn-plain" onClick={() => { setSetup(null); setCode(""); setError(null); }}>Cancelar</button>
                </form>
                {error ? <p className="field-err" role="alert"><Icon name="alert" size={18} />{error}</p> : null}
              </li>
            </ol>
          </div>
        ) : (
          <button type="button" className="btn btn-primary" disabled={pending} onClick={() => run(() => beginTwoFactorAction(), (r) => setSetup({ qr: r.qr, manualKey: r.manualKey }))}>
            Activar la verificación en dos pasos
          </button>
        )}
        {tf.required ? <p className="small muted" style={{ marginTop: 12 }}>El equipo la exige para todos los usuarios del panel (Configuración).</p> : null}
      </section>

      {/* Contraseña */}
      <section className="card" aria-labelledby="h-pw">
        <div className="card-h"><h2 id="h-pw">Contraseña</h2></div>
        <form
          className="acc-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (pwMismatch) return;
            run(() => changePasswordAction(pwForm.current, pwForm.next), () => setPwForm({ current: "", next: "", confirm: "" }));
          }}
        >
          <input type="text" name="username" autoComplete="username" value={data.user.email} readOnly hidden />
          <label className="field">
            <span>Contraseña actual</span>
            <input className="inp" type="password" autoComplete="current-password" required value={pwForm.current} onChange={(e) => setPwForm({ ...pwForm, current: e.target.value })} />
          </label>
          <label className="field">
            <span>Contraseña nueva</span>
            <input className="inp" type="password" autoComplete="new-password" required minLength={10} maxLength={72} value={pwForm.next} onChange={(e) => setPwForm({ ...pwForm, next: e.target.value })} />
            <span className="help">Entre 10 y 72 caracteres. Mejor una frase larga que no uses en otro sitio.</span>
          </label>
          <label className="field">
            <span>Repite la contraseña nueva</span>
            <input className="inp" type="password" autoComplete="new-password" required value={pwForm.confirm} aria-invalid={pwMismatch || undefined} onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })} />
            {pwMismatch ? <span className="field-err"><Icon name="alert" size={18} />No coincide con la contraseña nueva.</span> : null}
          </label>
          <button type="submit" className="btn btn-primary" disabled={pending || pwMismatch}>Cambiar contraseña</button>
          <p className="small muted">Al cambiarla se cierran tus sesiones en otros equipos.</p>
        </form>
      </section>

      {/* Sesiones */}
      <section className="card card-flush" aria-labelledby="h-ses">
        <div className="card-h">
          <h2 id="h-ses">Sesiones abiertas</h2>
          {data.sessions.length > 1 ? <button type="button" className="btn btn-plain" disabled={pending} onClick={() => run(() => revokeOtherSessionsAction())}>Cerrar las demás</button> : null}
        </div>
        <ul className="acc-list" aria-label="Sesiones abiertas">
          {data.sessions.map((s) => (
            <li key={s.id}>
              <Icon name="globe" size={20} />
              <div className="grow">
                <div className="t">{s.device} {s.current ? <span className="badge info sm">Esta sesión</span> : null}</div>
                <div className="s">IP {s.ip ?? "—"} · abierta {when(s.createdAt)} · última actividad {when(s.lastSeenAt ?? s.createdAt)}</div>
              </div>
              {!s.current ? <button type="button" className="btn" disabled={pending} onClick={() => run(() => revokeSessionAction(s.id))}>Cerrar</button> : null}
            </li>
          ))}
        </ul>
      </section>

      {tf.enabled || data.devices.length ? (
        <section className="card card-flush" aria-labelledby="h-dev">
          <div className="card-h">
            <h2 id="h-dev">Equipos recordados</h2>
            {data.devices.length ? <button type="button" className="btn btn-plain" disabled={pending} onClick={() => run(() => forgetDevicesAction())}>Olvidar todos</button> : null}
          </div>
          {data.devices.length ? (
            <ul className="acc-list" aria-label="Equipos recordados">
              {data.devices.map((x) => (
                <li key={x.id}>
                  <Icon name="lock" size={20} />
                  <div className="grow">
                    <div className="t">{x.device}</div>
                    <div className="s">No pide el código hasta el {when(x.expiresAt)} · último uso {when(x.lastUsedAt ?? x.createdAt)}</div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted acc-p" style={{ padding: "0 16px 16px" }}>Ninguno. Al iniciar sesión puedes marcar «No volver a pedir el código en este equipo durante 30 días».</p>
          )}
        </section>
      ) : null}

      {modal ? (
        <Modal
          title={modal === "disable" ? "Desactivar la verificación en dos pasos" : "Generar códigos de recuperación nuevos"}
          onClose={() => setModal(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setModal(null)}>Cancelar</button>
              <button
                type="button"
                className={`btn ${modal === "disable" ? "btn-critical" : "btn-primary"}`}
                disabled={pending || !pw.password || (modal === "disable" && !pw.code.trim())}
                onClick={() =>
                  modal === "disable"
                    ? run(() => disableTwoFactorAction(pw.password, pw.code), () => setModal(null), true)
                    : run(() => regenerateCodesAction(pw.password), (r) => { setModal(null); setCodes(r.recoveryCodes); }, true)
                }
              >
                {modal === "disable" ? "Desactivar" : "Generar"}
              </button>
            </>
          }
        >
          {error ? <div className="banner critical" role="alert"><Icon name="alert" /><span>{error}</span></div> : null}
          <p className="muted" style={{ marginBottom: 12 }}>
            {modal === "disable"
              ? "Sin la verificación, basta la contraseña para entrar al panel. Confirma con tu contraseña y un código de la app (o uno de recuperación)."
              : "Los códigos anteriores dejarán de servir. Confirma con tu contraseña."}
          </p>
          <label className="field">
            <span>Contraseña</span>
            <input className="inp" type="password" autoComplete="current-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} autoFocus />
          </label>
          {modal === "disable" ? (
            <label className="field">
              <span>Código de la app o de recuperación</span>
              <input className="inp" autoComplete="one-time-code" value={pw.code} onChange={(e) => setPw({ ...pw, code: e.target.value })} />
            </label>
          ) : null}
        </Modal>
      ) : null}
      {toast.node}
    </div>
  );
}
