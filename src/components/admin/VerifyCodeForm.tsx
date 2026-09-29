"use client";
// Paso 2 del inicio de sesión: código de 6 dígitos de la app (o un código de recuperación) y «Recordar este equipo».
import Link from "next/link";
import { useActionState, useState } from "react";
import { verifyLoginCodeAction, type VerifyState } from "@/app/admin/auth-actions";
import { Icon } from "./Icon";

export function VerifyCodeForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<VerifyState, FormData>(verifyLoginCodeAction, {});
  const [recovery, setRecovery] = useState(false);
  const [lastState, setLastState] = useState(state);
  if (lastState !== state) {
    setLastState(state);
    if (state.recovery != null) setRecovery(state.recovery);
  }
  return (
    <form action={action}>
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="recovery" value={recovery ? "1" : "0"} />
      {state.error ? (
        <div className="banner critical" role="alert">
          <Icon name="alert" />
          <span>{state.error}</span>
        </div>
      ) : null}
      {recovery ? (
        <label className="field" key="rec">
          <span>Código de recuperación</span>
          <input className="inp" name="code" autoComplete="off" autoCapitalize="none" spellCheck={false} required placeholder="abcde-fghjk" autoFocus style={{ minHeight: 36, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }} />
          <span className="help">Cada código de recuperación sirve una sola vez.</span>
        </label>
      ) : (
        <label className="field" key="app">
          <span>Código de verificación</span>
          <input
            className="inp"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            required
            placeholder="123 456"
            autoFocus
            style={{ minHeight: 36, fontSize: 20, letterSpacing: "0.2em", fontVariantNumeric: "tabular-nums" }}
          />
        </label>
      )}
      <label className="check" style={{ margin: "4px 0 12px" }}>
        <input type="checkbox" name="remember" />
        <span className="t">No volver a pedir el código en este equipo durante 30 días</span>
      </label>
      <button className="btn btn-primary btn-lg" type="submit" disabled={pending} style={{ width: "100%" }}>
        {pending ? "Verificando…" : "Verificar"}
      </button>
      <div className="login-links">
        <button type="button" className="btn btn-plain" onClick={() => setRecovery((v) => !v)}>
          {recovery ? "Usar el código de la app" : "¿No tienes el teléfono? Usa un código de recuperación"}
        </button>
        <Link className="btn btn-plain" href="/admin/login">Volver a iniciar sesión</Link>
      </div>
    </form>
  );
}
