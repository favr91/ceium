"use server";
// Acciones de la ficha del pedido: verificar (aprobar/rechazar) un pago manual y reembolsar un pago.
// Los servicios vuelven a comprobar rol y usuario activo (requireAdmin) y dejan su OrderEvent.
import { redirect } from "next/navigation";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { requireAdminAction } from "../../_lib/session";

function back(orderId: string, params: Record<string, string>): string {
  return `/admin/orders/${encodeURIComponent(orderId)}?${new URLSearchParams(params)}`;
}

function failure(e: unknown, fallback: string): string {
  if (isDomainError(e)) return e.message;
  console.error("[admin/orders]", e);
  return fallback;
}

/** Convierte "1.234,56" / "1234.56" / "1234" en centavos. */
function parseCents(raw: FormDataEntryValue | null): number | undefined {
  let s = String(raw ?? "").trim().replace(/[\s$]/g, "");
  if (!s) return undefined;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export async function verifyPaymentAction(orderId: string, paymentId: string, decision: "approve" | "reject", formData: FormData): Promise<never> {
  const user = await requireAdminAction();
  let target: string;
  try {
    const note = String(formData.get("note") ?? "").trim() || null;
    await services().payments.adminVerifyPayment(user, { paymentId, decision, note });
    target = back(orderId, { ok: decision === "approve" ? "aprobado" : "rechazado" });
  } catch (e) {
    target = back(orderId, { error: failure(e, "No pudimos registrar la verificación. Intenta de nuevo.") });
  }
  redirect(target);
}

export async function refundPaymentAction(orderId: string, paymentId: string, formData: FormData): Promise<never> {
  const user = await requireAdminAction();
  let target: string;
  try {
    const amountCents = parseCents(formData.get("amount"));
    if (amountCents !== undefined && (!Number.isInteger(amountCents) || amountCents <= 0)) throw Object.assign(new Error("Monto inválido."), { code: "VALIDATION" });
    const r = await services().payments.refundPayment(user, {
      paymentId,
      amountCents,
      reason: String(formData.get("reason") ?? "").trim() || null,
      unenroll: formData.get("unenroll") === "on",
      releaseSeat: formData.get("releaseSeat") === "on",
      keepCertificate: formData.get("keepCertificate") === "on",
      manual: formData.get("manual") === "on",
      confirmRepeat: formData.get("confirmRepeat") === "on",
      idempotencyKey: String(formData.get("idempotencyKey") ?? "") || null,
    });
    target = back(orderId, { ok: r.fullyRefunded ? "reembolsado" : "reembolso-parcial" });
  } catch (e) {
    const msg = (e as { code?: string })?.code === "VALIDATION" && !isDomainError(e) ? (e as Error).message : failure(e, "No pudimos procesar el reembolso. Intenta de nuevo.");
    target = back(orderId, { error: msg });
  }
  redirect(target);
}
