"use client";
import { useActionState } from "react";
import { loginAction, type LoginState } from "@/app/admin/auth-actions";
import { Icon } from "./Icon";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="next" value={next} />
      {state.error ? (
        <div className="banner critical" role="alert">
          <Icon name="alert" />
          <span>{state.error}</span>
        </div>
      ) : null}
      <label className="field">
        <span>Correo electrónico</span>
        <input className="inp" type="email" name="email" autoComplete="username" required defaultValue={state.email} autoFocus style={{ minHeight: 36 }} />
      </label>
      <label className="field">
        <span>Contraseña</span>
        <input className="inp" type="password" name="password" autoComplete="current-password" required style={{ minHeight: 36 }} />
      </label>
      <button className="btn btn-primary btn-lg" type="submit" disabled={pending} style={{ width: "100%", marginTop: 8 }}>
        {pending ? "Entrando…" : "Iniciar sesión"}
      </button>
    </form>
  );
}
