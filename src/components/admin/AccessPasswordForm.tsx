"use client";
// Formulario del enlace de acceso: contraseña nueva + repetirla. Al guardar, invita a iniciar sesión.
import Link from "next/link";
import { useState, useTransition } from "react";
import { setPasswordWithLinkAction } from "@/app/admin/acceso/[token]/actions";
import { Icon } from "./Icon";

export function AccessPasswordForm({ token, email, kind }: { token: string; email: string; kind: "invite" | "reset" }) {
  const [pw, setPw] = useState({ next: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  const mismatch = !!pw.confirm && pw.next !== pw.confirm;

  if (done) {
    return (
      <>
        <div className="banner success" role="status" style={{ marginBottom: 16 }}>
          <Icon name="check" />
          <span>{kind === "invite" ? "Listo, tu contraseña quedó creada." : "Listo, tu contraseña quedó cambiada."} Ya puedes iniciar sesión.</span>
        </div>
        <Link className="btn btn-primary btn-lg" href="/admin/login" style={{ width: "100%" }}>Iniciar sesión</Link>
      </>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (mismatch) return;
        setError(null);
        start(async () => {
          const r = await setPasswordWithLinkAction(token, pw.next, pw.confirm);
          if (r.ok) setDone(true);
          else setError(r.error);
        });
      }}
    >
      {error ? <div className="banner critical" role="alert"><Icon name="alert" /><span>{error}</span></div> : null}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <label className="field">
        <span>Contraseña nueva</span>
        <input className="inp" type="password" autoComplete="new-password" required minLength={10} maxLength={72} autoFocus value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} style={{ minHeight: 36 }} />
        <span className="help">Entre 10 y 72 caracteres. Mejor una frase larga que no uses en otro sitio.</span>
      </label>
      <label className="field">
        <span>Repite la contraseña</span>
        <input className="inp" type="password" autoComplete="new-password" required value={pw.confirm} aria-invalid={mismatch || undefined} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} style={{ minHeight: 36 }} />
        {mismatch ? <span className="field-err"><Icon name="alert" size={18} />No coincide.</span> : null}
      </label>
      <button className="btn btn-primary btn-lg" type="submit" disabled={pending || mismatch} style={{ width: "100%", marginTop: 8 }}>
        {pending ? "Guardando…" : kind === "invite" ? "Crear contraseña" : "Guardar contraseña"}
      </button>
    </form>
  );
}
