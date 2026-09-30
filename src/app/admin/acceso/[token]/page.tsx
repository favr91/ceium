// Enlace de acceso al panel (invitación o restablecer la contraseña, ver server/admin-access.ts): la persona crea su
// contraseña y luego inicia sesión como siempre (con la verificación en dos pasos si la tiene).
import type { Metadata } from "next";
import Link from "next/link";
import { readAccessLink } from "@/server/admin-access";
import { ROLE_LABEL } from "@/server/admin-roles";
import { services } from "@/server/services";
import { AccessPasswordForm } from "@/components/admin/AccessPasswordForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Crear contraseña", robots: { index: false, follow: false } };

export default async function AccessPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const d = services().deps;
  const link = await readAccessLink(d.db, token, d.now());
  return (
    <main className="login">
      <div className="card">
        <div className="row">
          <span className="adm-brand-mark" style={{ width: 36, height: 36, fontSize: 18, borderRadius: 10 }}>C</span>
          <span className="strong" style={{ fontSize: 16 }}>CEIUM</span>
        </div>
        {link ? (
          <>
            <h1>{link.kind === "invite" ? `Hola, ${link.name.split(" ")[0]}` : "Crea una contraseña nueva"}</h1>
            <p className="muted" style={{ marginBottom: 20 }}>
              {link.kind === "invite" ? (
                <>Te dieron acceso al panel de CEIUM como <b>{ROLE_LABEL[link.role]}</b>. Crea tu contraseña para <b>{link.email}</b>.</>
              ) : (
                <>Para tu cuenta del panel <b>{link.email}</b>. Al guardarla se cierran tus sesiones abiertas.</>
              )}
            </p>
            <AccessPasswordForm token={token} email={link.email} kind={link.kind} />
          </>
        ) : (
          <>
            <h1>Este enlace ya no es válido</h1>
            <p className="muted" style={{ marginBottom: 20 }}>Se usó, venció o la cuenta fue desactivada. Pide a quien te invitó que te envíe uno nuevo desde Equipo.</p>
            <Link className="btn btn-lg" href="/admin/login" style={{ width: "100%" }}>Ir a iniciar sesión</Link>
          </>
        )}
      </div>
    </main>
  );
}
