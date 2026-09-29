import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_CHALLENGE_COOKIE, pendingChallengeEmail } from "@/server/auth";
import { prisma } from "@/server/db";
import { currentAdmin } from "../../_lib/session";
import { VerifyCodeForm } from "@/components/admin/VerifyCodeForm";

export const metadata: Metadata = { title: "Verificación en dos pasos", robots: { index: false, follow: false } };

// Paso 2 del inicio de sesión: la contraseña ya se validó (cookie del desafío, 10 minutos); falta el código.
export default async function VerifyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "";
  if (await currentAdmin()) redirect(next.startsWith("/admin") ? next : "/admin/products");
  const email = await pendingChallengeEmail(prisma, (await cookies()).get(ADMIN_CHALLENGE_COOKIE)?.value);
  if (!email) redirect("/admin/login?vencido=1");
  return (
    <main className="login">
      <div className="card">
        <div className="row">
          <span className="adm-brand-mark" style={{ width: 36, height: 36, fontSize: 18, borderRadius: 10 }}>C</span>
          <span className="strong" style={{ fontSize: 16 }}>CEIUM</span>
        </div>
        <h1>Verificación en dos pasos</h1>
        <p className="muted" style={{ marginBottom: 20 }}>
          Abre tu app autenticadora y escribe el código de 6 dígitos de <b>CEIUM ({email})</b>.
        </p>
        <VerifyCodeForm next={next} />
      </div>
    </main>
  );
}
