// POST /api/checkout/comprobante — el médico registra su pago manual (pago móvil, transferencia, Zelle) desde el
// checkout, con el pedido en curso y el cupo reservado: referencia, banco de origen, monto, fecha y comprobante.
//   - El pedido sale de la cookie del checkout (mismo carrito, reserva viva), nunca del formulario.
//   - Se valida igual que en el navegador (manual-payment-fields.ts); el método y su moneda salen de la
//     configuración del panel y el equivalente en USD se calcula con la tasa del panel (recordManualPayment).
//   - Éxito: el pago queda AWAITING_VERIFICATION (el pedido también), el cupo sigue apartado hasta que el admin
//     decida, sale el correo «pago en verificación» y se vacía el carrito → página del pedido «en verificación».
// Con `Accept: application/json` (el formulario con JavaScript) responde JSON; sin JavaScript, 303 a la página
// del pedido o de vuelta al checkout con el motivo. Va por route handler (no server action) porque el
// comprobante puede pesar hasta 10 MB.
import fs from "node:fs/promises";
import path from "node:path";
import { CART_COOKIE } from "@/server/cart";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { CHECKOUT_COOKIE, findPendingOrder, readCheckoutCookies } from "@/app/(checkout)/checkout/data";
import { MANUAL_FIELD_ORDER, normalizeReference, parseAmountCents, todayCaracas, validateManualPayment, type ManualErrors, type ManualField } from "@/components/checkout/manual-payment-fields";

export const dynamic = "force-dynamic";

const CART_COUNT_COOKIE = "ceium_cart_count";

type Body = { ok: true; redirect: string } | { ok: false; formError: string; fieldErrors?: ManualErrors; expired?: boolean };

function reply(req: Request, status: number, body: Body, clear: string[] = []): Response {
  const json = (req.headers.get("accept") ?? "").includes("application/json");
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of clear) headers.append("set-cookie", `${name}=; Path=/; Max-Age=0; SameSite=Lax`);
  if (json) {
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(body), { status, headers });
  }
  let to: URL;
  if (body.ok) to = new URL(body.redirect, req.url);
  else {
    to = new URL("/checkout", req.url);
    to.searchParams.set("pago", body.expired ? "vencido" : "error");
    const first = MANUAL_FIELD_ORDER.find((k) => body.fieldErrors?.[k]);
    to.searchParams.set("motivo", first ? body.fieldErrors![first]! : body.formError);
  }
  headers.set("location", to.toString());
  return new Response(null, { status: 303, headers });
}

const str = (fd: FormData, k: string, max = 120) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.slice(0, max) : "";
};

export async function POST(req: Request) {
  const fail = (status: number, formError: string, fieldErrors?: ManualErrors, expired?: boolean) => reply(req, status, { ok: false, formError, fieldErrors, expired });

  const { lines, pendingRef } = await readCheckoutCookies();
  const order = await findPendingOrder(lines, pendingRef);
  if (!order) return fail(409, "Tu reserva ya no está vigente o el pedido ya tiene un pago registrado. Revisa tu pedido y vuelve a intentarlo.", undefined, true);

  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return fail(400, "No pudimos leer los datos del pago. Intenta de nuevo.");
  }

  const s = services();
  const method = str(fd, "method", 40);
  const opt = (await s.orders.listPaymentOptions()).find((o) => o.method === method && o.method !== "PAYPAL" && o.method !== "EFECTIVO");
  if (!opt) return fail(422, "El método de pago seleccionado no está disponible. Elige otro método.");

  const values = { reference: str(fd, "reference", 60), bank: str(fd, "bank", 100), amount: str(fd, "amount", 30), paidAt: str(fd, "paidAt", 10) };
  const raw = fd.get("proof");
  const file = raw && typeof raw === "object" && "arrayBuffer" in raw ? (raw as File) : null;
  const fieldErrors = validateManualPayment(values, file ? { name: file.name, size: file.size } : null, opt.currency, todayCaracas());
  if (Object.keys(fieldErrors).length) return fail(422, "Revisa los datos del pago.", fieldErrors);

  let proofFile: string | null = null;
  try {
    proofFile = await s.payments.storeProofFile(order.id, file!.name, new Uint8Array(await file!.arrayBuffer()));
    await s.payments.recordManualPayment({
      orderId: order.id,
      method: opt.method as "PAGO_MOVIL" | "TRANSFERENCIA" | "ZELLE",
      reference: normalizeReference(values.reference),
      bank: values.bank.trim() || null,
      amountCents: parseAmountCents(values.amount),
      currency: opt.currency,
      // Mediodía en Venezuela: la fecha declarada no cambia de día con la zona horaria.
      paidAt: new Date(`${values.paidAt}T12:00:00-04:00`),
      proofFile,
    });
  } catch (e) {
    if (proofFile) await fs.unlink(path.resolve(proofFile)).catch(() => {});
    if (!isDomainError(e)) {
      console.error("[checkout/comprobante]", e);
      return fail(500, "No pudimos registrar tu pago. Intenta de nuevo en unos segundos; tu cupo sigue reservado.");
    }
    const f = e.details?.field;
    const field: ManualField | null = f === "reference" ? "reference" : f === "amountCents" ? "amount" : /comprobante/i.test(e.message) ? "proof" : null;
    if (field) return fail(422, "Revisa los datos del pago.", { [field]: e.message });
    return fail(e.code === "INVALID_STATE" ? 409 : 422, e.message);
  }

  return reply(req, 200, { ok: true, redirect: `/pedido/${encodeURIComponent(order.token)}?pago=registrado` }, [CART_COOKIE, CART_COUNT_COOKIE, CHECKOUT_COOKIE]);
}
