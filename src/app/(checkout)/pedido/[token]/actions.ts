"use server";
// Acciones de la página del pedido (/pedido/[token]): iniciar el pago con PayPal y registrar un pago manual
// (pago móvil / transferencia…) con su comprobante. El token del pedido es la única credencial del comprador.
import { redirect } from "next/navigation";
import { services } from "@/server/services";
import { isDomainError } from "@/server/errors";
import { normalizeReference, parseAmountCents, proofError } from "@/components/checkout/manual-payment-fields";

function back(token: string, params: Record<string, string>, hash = ""): string {
  return `/pedido/${encodeURIComponent(token)}?${new URLSearchParams(params)}${hash}`;
}

/** POST «Pagar con PayPal»: crea la orden PayPal por lo que se debe ahora y redirige a PayPal. */
export async function payOrderWithPaypal(token: string, installmentId: string | null): Promise<never> {
  const s = services();
  let target: string;
  try {
    const order = await s.orders.getOrderByToken(token);
    const ins = installmentId ? order.installments.find((i) => i.id === installmentId) : null;
    target = (await s.payments.startPaypalPayment(order.id, ins ? { installmentId: ins.id } : undefined)).approveUrl;
  } catch (e) {
    if (!isDomainError(e)) console.error("[pedido/paypal]", e);
    target = back(token, { pago: "error", motivo: isDomainError(e) ? e.message : "No pudimos iniciar el pago con PayPal. Intenta de nuevo." });
  }
  redirect(target);
}

/** POST del formulario de pago manual: guarda el comprobante y registra el pago (queda en verificación). */
export async function reportManualPayment(token: string, cuota: string | null, formData: FormData): Promise<never> {
  const s = services();
  const hash = "#pagar";
  const keep: Record<string, string> = cuota ? { cuota } : {};
  let target: string;
  try {
    const order = await s.orders.getOrderByToken(token);
    const method = String(formData.get("method") ?? "");
    const options = await s.orders.listPaymentOptions();
    const opt = options.find((o) => o.method === method && o.method !== "PAYPAL");
    if (!opt) throw Object.assign(new Error("El método de pago seleccionado no está disponible."), { code: "VALIDATION" });
    // El comprobante (archivo) es obligatorio para todo pago manual que reporta el cliente, salvo el efectivo en
    // sede: sin él el admin no tiene nada que verificar. Mismas reglas que /api/checkout/comprobante.
    const raw = formData.get("proof");
    const file = raw && typeof raw === "object" && "arrayBuffer" in raw ? (raw as File) : null;
    const hasFile = !!file && file.size > 0;
    if (opt.method !== "EFECTIVO" || hasFile) {
      const problem = proofError(file ? { name: file.name, size: file.size } : null);
      if (problem) throw Object.assign(new Error(problem), { code: "VALIDATION" });
    }
    const proofFile = hasFile ? await s.payments.storeProofFile(order.id, file!.name, new Uint8Array(await file!.arrayBuffer())) : null;
    const paidAtRaw = String(formData.get("paidAt") ?? "");
    await s.payments.recordManualPayment({
      orderId: order.id,
      method: opt.method as "PAGO_MOVIL" | "TRANSFERENCIA" | "ZELLE" | "EFECTIVO",
      reference: normalizeReference(String(formData.get("reference") ?? "")),
      bank: String(formData.get("bank") ?? "") || null,
      // Mismo intérprete que el checkout: «33.705» es Bs. 33.705,00 (punto de miles), no Bs. 33,71.
      amountCents: parseAmountCents(String(formData.get("amount") ?? "")),
      currency: opt.currency,
      paidAt: paidAtRaw ? new Date(`${paidAtRaw}T12:00:00`) : null,
      proofFile,
      payerName: String(formData.get("payerName") ?? "") || null,
      payerPhone: String(formData.get("payerPhone") ?? "") || null,
      payerCedula: String(formData.get("payerCedula") ?? "") || null,
    });
    target = back(token, { ...keep, pago: "registrado" });
  } catch (e) {
    const known = isDomainError(e) || (e as { code?: string })?.code === "VALIDATION";
    if (!known) console.error("[pedido/pago-manual]", e);
    target = back(token, { ...keep, pago: "error", motivo: known ? (e as Error).message : "No pudimos registrar tu pago. Intenta de nuevo." }, hash);
  }
  redirect(target);
}
