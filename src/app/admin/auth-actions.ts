"use server";
// Inicio y cierre de sesión del panel.
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { ADMIN_SESSION_COOKIE, adminCookieOptions, login, logout } from "@/server/auth";
import { isDomainError } from "@/server/errors";

export interface LoginState { error?: string; email?: string }

function safeNext(raw: FormDataEntryValue | null): string {
  const n = String(raw ?? "");
  return n.startsWith("/admin") && !n.startsWith("//") && !n.startsWith("/admin/login") ? n : "/admin/products";
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const h = await headers();
  try {
    const r = await login(prisma, { email, password: String(formData.get("password") ?? ""), ip: h.get("x-forwarded-for"), userAgent: h.get("user-agent") });
    (await cookies()).set(ADMIN_SESSION_COOKIE, r.token, adminCookieOptions(r.expiresAt));
  } catch (e) {
    if (isDomainError(e)) return { error: e.message, email };
    console.error("[admin/login]", e);
    return { error: "No pudimos iniciar sesión. Intenta de nuevo.", email };
  }
  redirect(safeNext(formData.get("next")));
}

export async function logoutAction(): Promise<never> {
  const jar = await cookies();
  await logout(prisma, jar.get(ADMIN_SESSION_COOKIE)?.value);
  jar.delete(ADMIN_SESSION_COOKIE);
  redirect("/admin/login");
}
