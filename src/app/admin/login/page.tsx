import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAdmin } from "../_lib/session";
import { LoginForm } from "@/components/admin/LoginForm";

export const metadata: Metadata = { title: "Iniciar sesión" };

export default async function LoginPage({ searchParams }: PageProps<"/admin/login">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "";
  if (await currentAdmin()) redirect(next.startsWith("/admin") ? next : "/admin/products");
  return (
    <main className="login">
      <div className="card">
        <div className="row">
          <span className="adm-brand-mark" style={{ width: 36, height: 36, fontSize: 18, borderRadius: 10 }}>C</span>
          <span className="strong" style={{ fontSize: 16 }}>CEIUM</span>
        </div>
        <h1>Inicia sesión</h1>
        <p className="muted" style={{ marginBottom: 20 }}>para continuar al panel de CEIUM</p>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
