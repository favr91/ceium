// Panel · Pedidos (pieza a3): índice con vistas, búsqueda, filtros, orden y exportación; ficha de un pago
// móvil por verificar (comprobante, comprobaciones, aprobar / rechazar con motivo); diálogo de reembolso de un
// pedido PayPal (parcial y luego total, contra el mock de PayPal); cronología con comentarios; y correcciones
// (ajustar saldo, reenviar correo, cancelar un pedido sin pagar). Los pedidos se crean con los servicios de
// dominio reales (tests/e2e/support/a3-fixture.ts): checkout, PayPal aprobado en el mock, pagos manuales con
// comprobante, rechazo y reembolsos.
//   E2E_LANE=panel E2E_PORT=3103 npx playwright test tests/e2e/a3-orders.spec.ts
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { e2eEnv } from "../../playwright.config";
import { PAYPAL, one, q } from "./support/purchase";

type Ref = { id: string; number: number };
type Orders = Record<"paypalPaid" | "paypalHalf" | "rejected" | "refunded" | "monthly" | "partialRefund" | "pending" | "paypalFull" | "awaiting" | "awaiting2", Ref>;

function createOrders(): Orders {
  const keys = ["DATABASE_URL", "APP_URL", "MAIL_DIR", "PRIVATE_FILES_DIR", "CERTIFICATES_DIR", "MOODLE_URL", "MOODLE_TOKEN", "MOODLE_LOGIN_URL", "PAYPAL_BASE_URL", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"] as const;
  const out = execFileSync("npx", ["tsx", "tests/e2e/support/a3-fixture.ts", "orders"], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, ...Object.fromEntries(keys.map((k) => [k, e2eEnv[k]])), NODE_ENV: "production" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const line = out.split("\n").find((l) => l.startsWith("@@JSON "));
  if (!line) throw new Error(`a3-fixture sin resultado:\n${out}`);
  return JSON.parse(line.slice(7)) as Orders;
}

async function login(page: Page, next = "/admin/orders") {
  await page.goto(`/admin/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Correo electrónico", { exact: true }).fill("admin@ceium.net");
  await page.getByLabel("Contraseña", { exact: true }).fill("ceium-admin-2026");
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((u) => u.pathname === next.split("?")[0]);
}

const emailOf = (orderId: string) => one<{ email: string }>(`SELECT c.email FROM Customer c JOIN "Order" o ON o.customerId = c.id WHERE o.id = ?`, orderId).email;
const orderRow = (id: string) => one<{ status: string; amountPaidCents: number; balanceCents: number; totalCents: number }>(`SELECT status, amountPaidCents, balanceCents, totalCents FROM "Order" WHERE id = ?`, id);
const refOf = (orderId: string) => one<{ reference: string }>(`SELECT reference FROM Payment WHERE orderId = ? ORDER BY createdAt LIMIT 1`, orderId).reference;
const eventTypes = (id: string) => q<{ type: string; actorType: string; note: string | null }>(`SELECT type, actorType, note FROM OrderEvent WHERE orderId = ? ORDER BY createdAt, id`, id);

let O: Orders;
test.beforeAll(() => {
  test.setTimeout(180_000);
  O = createOrders();
});

test.describe("panel · pedidos", () => {
  test("índice: métricas, pestañas con conteo, búsqueda, filtros, orden, lista móvil y CSV", async ({ page }, info) => {
    const mobile = info.project.name === "mobile";
    await login(page);
    await expect(page.getByRole("heading", { level: 1, name: "Pedidos" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "por verificar" })).toBeVisible();
    const awaitingDb = one<{ n: number }>(`SELECT COUNT(*) n FROM Payment WHERE status = 'AWAITING_VERIFICATION'`).n;
    await expect(page.getByTestId("metric-awaiting")).toContainText(String(awaitingDb));

    // Búsqueda por correo del médico (filtra mientras se escribe) → el pedido por verificar, con sus badges.
    await page.getByRole("button", { name: "Buscar y filtrar" }).click();
    await page.getByRole("searchbox", { name: "Buscar pedidos" }).fill(emailOf(O.awaiting.id));
    await expect(page).toHaveURL(/q=/);
    const scope = mobile ? page.getByTestId("orders-list") : page.getByTestId("orders-table");
    if (mobile) {
      const item = scope.getByRole("link", { name: new RegExp(`Pedido #${O.awaiting.number}\\b`) });
      await expect(item).toBeVisible();
      await expect(item).toContainText("Por verificar");
      await expect(item).toContainText("Sin matricular");
      await expect(scope.getByRole("listitem")).toHaveCount(1);
    } else {
      const row = scope.locator(`tr[data-order-number="${O.awaiting.number}"]`);
      await expect(row).toBeVisible();
      await expect(row).toContainText("Por verificar");
      await expect(row).toContainText("Sin matricular");
      await expect(row).toContainText("Pago móvil");
      await expect(scope.locator("tbody tr")).toHaveCount(1);
      // Programas del pedido en un popover.
      await row.getByRole("button", { name: /1 programa/ }).click();
      await expect(page.getByRole("dialog", { name: `Programas del pedido #${O.awaiting.number}` })).toContainText("Curso Universitario: Enfermedades Materno Fetales");
    }

    // Vista «Por verificar»: solo pedidos con pago por verificar.
    await page.getByRole("button", { name: "Cancelar" }).click();
    await expect(page).not.toHaveURL(/q=/);
    await page.getByRole("tab", { name: /^Por verificar/ }).click();
    await expect(page).toHaveURL(/view=AWAITING_VERIFICATION/);
    await expect(page.getByRole("tab", { name: /^Por verificar/ })).toHaveAttribute("aria-selected", "true");
    const rows = mobile ? page.getByTestId("orders-list").getByRole("listitem") : page.getByTestId("orders-table").locator("tbody tr");
    await expect(rows.first()).toBeVisible();
    // Cada fila tiene un pago por verificar: el pedido está «Por verificar» o (pedido ya pagado con otro pago, p.ej.
    // PayPal cobrado a la vez que se registraba un pago móvil) lleva la marca de pago por verificar.
    for (const row of await rows.all()) {
      const pending = (await row.textContent())?.includes("Por verificar") || (await row.locator(".dot-attn").count()) > 0;
      expect(pending, (await row.textContent()) ?? "").toBe(true);
    }

    // Filtro por método (PayPal) en «Todos» y orden por total (mayor a menor).
    await page.getByRole("tab", { name: /^Todos/ }).click();
    await page.getByRole("button", { name: "Buscar y filtrar" }).click();
    await page.getByRole("button", { name: "Método de pago" }).click();
    await page.getByRole("group", { name: "Método de pago" }).getByText("PayPal", { exact: true }).click();
    await expect(page).toHaveURL(/method=PAYPAL/);
    await expect(page.getByRole("button", { name: /Método de pago: PayPal/ })).toBeVisible();
    if (!mobile) {
      await expect(page.getByTestId("orders-table").locator(`tr[data-order-number="${O.awaiting.number}"]`)).toHaveCount(0);
      for (const t of await page.getByTestId("orders-table").locator("tbody tr td:nth-child(9)").allTextContents()) expect(t).toBe("PayPal");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Ordenar" }).click();
      await page.getByRole("button", { name: "Total" }).click();
      await expect(page).toHaveURL(/sort=total/);
      const totals = (await page.getByTestId("orders-table").locator("tbody tr td:nth-child(5)").allTextContents()).map((t) => Number(t.replace(/[^\d.]/g, "")));
      expect(totals.length).toBeGreaterThan(2);
      expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    }

    // CSV de la vista (con sesión del panel) incluye los pedidos PayPal filtrados.
    const csv = await page.request.get(`/admin/orders/export?method=PAYPAL`);
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    const body = await csv.text();
    expect(body).toContain(`#${O.paypalFull.number},`);
    expect(body).not.toContain(`#${O.awaiting.number},`);
    const anon = await page.context().browser()!.newContext();
    expect((await anon.request.get(`${e2eEnv.APP_URL}/admin/orders/export`)).status()).toBe(401);
    await anon.close();
  });

  test("ficha de un pago móvil por verificar: comprobante, comprobaciones y aprobación", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "una aprobación por corrida");
    await login(page, `/admin/orders/${O.awaiting.id}`);
    await expect(page.getByRole("heading", { level: 1, name: `Pedido #${O.awaiting.number}` })).toBeVisible();
    await expect(page.getByTestId("order-status")).toHaveText("En verificación");
    await expect(page.getByRole("note").filter({ hasText: "Hay un pago por verificar" })).toBeVisible();
    const card = page.getByTestId("payment").filter({ hasText: refOf(O.awaiting.id) });
    await expect(card.getByTestId("payment-status")).toHaveText("Por verificar");
    await expect(card).toContainText("Bs. 8.395,00");
    await expect(card).toContainText("≈ $230.00");
    const checks = card.getByRole("list", { name: "Comprobaciones" });
    await expect(checks).toContainText("El monto cubre lo que se espera de este pago ($230.00)");
    await expect(checks).toContainText("La referencia no se ha usado en otro pedido");
    await expect(checks).toContainText("no es el médico"); // pagó el esposo (otra cédula)
    const img = card.getByTestId("proof").getByRole("img", { name: /Comprobante/ });
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(540);
    // Ampliar el comprobante y cerrar con Escape.
    await card.getByRole("button", { name: "Ampliar comprobante" }).click();
    await expect(page.getByRole("dialog", { name: "Comprobante ampliado" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Comprobante ampliado" })).toHaveCount(0);
    await expect(page.getByTestId("seat-status")).toContainText("Reservado");
    await expect(page.getByTestId("emails")).toContainText("Pago en verificación");

    await card.getByRole("button", { name: "Aprobar pago" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Pago aprobado" })).toBeVisible();
    await expect(page.getByTestId("order-status")).toHaveText("Inscrito");
    await expect(card.getByTestId("payment-status")).toHaveText("Confirmado");
    await expect(card).toContainText("Verificado por Administrador CEIUM");
    await expect(page.getByTestId("seat-status")).toContainText("Ocupado");
    await expect(page.getByTestId("enrollments")).toContainText("Matriculado");
    await expect(page.getByTestId("timeline")).toContainText("Pago aprobado por Administrador CEIUM");
    expect(orderRow(O.awaiting.id)).toMatchObject({ status: "ENROLLED", amountPaidCents: 23000, balanceCents: 0 });
    expect(eventTypes(O.awaiting.id).find((e) => e.type === "PAYMENT_VERIFIED")).toMatchObject({ actorType: "ADMIN" });
  });

  test("rechazar un pago con un motivo frecuente: el cupo se libera y el cliente recibe el motivo", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "un rechazo por corrida");
    await login(page, `/admin/orders/${O.awaiting2.id}`);
    const card = page.getByTestId("payment").filter({ hasText: refOf(O.awaiting2.id) });
    await card.getByRole("button", { name: "Rechazar pago" }).click();
    const form = card.getByRole("form", { name: "Rechazar pago" });
    // Sin motivo no se envía (el campo es obligatorio).
    await form.getByRole("button", { name: "Rechazar pago" }).click();
    expect(orderRow(O.awaiting2.id).status).toBe("AWAITING_VERIFICATION");
    await form.getByRole("button", { name: "No encontramos la referencia en el estado de cuenta" }).click();
    await expect(form.getByLabel("Motivo del rechazo")).toHaveValue("No encontramos la referencia en el estado de cuenta.");
    await form.getByRole("button", { name: "Rechazar pago" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Pago rechazado" })).toBeVisible();
    await expect(page.getByTestId("order-status")).toHaveText("Rechazado");
    await expect(page.getByTestId("seat-status")).toContainText("Liberado");
    await expect(card).toContainText("Motivo: No encontramos la referencia en el estado de cuenta.");
    await expect(page.getByTestId("timeline")).toContainText("Pago rechazado por Administrador CEIUM");
    await expect(page.getByTestId("emails")).toContainText("Pago rechazado");
    const mail = one<{ text: string }>(`SELECT text FROM EmailOutbox WHERE orderId = ? AND template = 'payment_rejected'`, O.awaiting2.id);
    expect(mail.text).toContain("No encontramos la referencia");
  });

  test("reembolso PayPal desde el diálogo: parcial (50 %) y luego el resto → Reembolsado", async ({ page, request }, info) => {
    test.skip(info.project.name !== "desktop", "reembolsos una vez por corrida");
    await login(page, `/admin/orders/${O.paypalFull.id}`);
    await expect(page.getByTestId("order-status")).toHaveText("Inscrito");
    const refundsBefore = ((await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { refunds?: unknown }).refunds;
    const nBefore = Array.isArray(refundsBefore) ? refundsBefore.length : Object.keys(refundsBefore ?? {}).length;

    // Se abre desde la cabecera, como en Shopify.
    await page.getByRole("button", { name: "Reembolsar", exact: true }).first().click();
    const form = page.getByRole("form", { name: "Reembolsar pago" });
    await expect(form).toBeVisible();
    await expect(form).toContainText("Disponible");
    await expect(form).toContainText("$1,089.00");
    await expect(form.getByRole("checkbox", { name: /Desmatricular de Moodle/ })).toBeChecked();
    await form.getByRole("button", { name: "50 %" }).click();
    await expect(form.getByLabel("Monto a reembolsar")).toHaveValue("544.50");
    // Parcial: por defecto no desmatricula (como el servicio).
    await expect(form.getByRole("checkbox", { name: /Desmatricular de Moodle/ })).not.toBeChecked();
    await form.getByLabel("Motivo").fill("Beca parcial otorgada por la coordinación.");
    await form.getByRole("button", { name: /^Reembolsar \$544\.50/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "Reembolso completado" })).toBeVisible();
    await expect(form).toHaveCount(0);
    await expect(page.getByTestId("order-status")).toHaveText("Inscrito");
    await expect(page.getByTestId("refunds")).toContainText("Reembolso completado");
    await expect(page.getByTestId("refunds")).toContainText("Beca parcial");
    expect(orderRow(O.paypalFull.id)).toMatchObject({ status: "ENROLLED", amountPaidCents: 54450 });

    // El resto desde la transacción (summary «Reembolsar» del pago): el pedido queda Reembolsado.
    const card = page.getByTestId("payment").filter({ hasText: "PayPal" });
    await card.getByTestId("refund").locator("summary").click();
    const form2 = card.getByRole("form", { name: "Reembolsar pago" });
    await expect(form2.getByLabel("Monto a reembolsar")).toHaveValue("544.50");
    await expect(form2).toContainText("El pedido quedará Reembolsado");
    await expect(form2.getByRole("checkbox", { name: /Desmatricular de Moodle/ })).toBeChecked();
    await form2.getByRole("button", { name: /^Reembolsar \$544\.50/ }).click();
    // Mismo monto sobre el mismo pago hace un momento: el servicio lo frena como posible doble envío y el
    // diálogo pide confirmarlo.
    await expect(form2.getByRole("alert")).toContainText("hace un momento");
    expect(orderRow(O.paypalFull.id).status).toBe("ENROLLED");
    await expect(form2.getByRole("button", { name: /^Reembolsar \$544\.50/ })).toBeDisabled();
    await form2.getByRole("checkbox", { name: "Es otro reembolso del mismo monto (no un doble envío)" }).check();
    await form2.getByRole("button", { name: /^Reembolsar \$544\.50/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "El pedido quedó reembolsado" })).toBeVisible();
    await expect(page.getByTestId("order-status")).toHaveText("Reembolsado");
    await expect(page.getByRole("button", { name: "Reembolsar", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("enrollments")).toContainText("desmatriculados");
    expect(orderRow(O.paypalFull.id)).toMatchObject({ status: "REFUNDED", amountPaidCents: 0 });
    const after = ((await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { refunds?: unknown }).refunds;
    const nAfter = Array.isArray(after) ? after.length : Object.keys(after ?? {}).length;
    expect(nAfter - nBefore).toBe(2);
    await expect(page.getByTestId("timeline")).toContainText("Se reembolsaron $544.50 por PayPal");
  });

  test("cronología y correcciones: comentar, ajustar saldo, ver y reenviar un correo, cancelar un pedido sin pagar", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "correcciones una vez por corrida");
    await login(page, `/admin/orders/${O.paypalHalf.id}`);
    const before = orderRow(O.paypalHalf.id);
    expect(before.balanceCents).toBeGreaterThan(5000);

    // Comentario interno.
    await page.getByRole("textbox", { name: "Comentario" }).fill("Llamó para confirmar que paga la segunda mitad en diciembre.");
    await page.getByRole("button", { name: "Publicar" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Comentario publicado" })).toBeVisible();
    await expect(page.getByTestId("timeline")).toContainText("Llamó para confirmar que paga la segunda mitad en diciembre.");

    // Ajustar saldo: descuento de $50.
    await page.getByRole("button", { name: "Más acciones" }).click();
    await page.getByRole("menuitem", { name: "Ajustar saldo" }).click();
    const dlg = page.getByRole("dialog", { name: "Ajustar saldo" });
    await dlg.getByRole("textbox", { name: "Monto" }).fill("50");
    await dlg.getByRole("textbox", { name: "Motivo" }).fill("Descuento por referir a un colega");
    await dlg.getByRole("button", { name: "Guardar ajuste" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saldo ajustado" })).toBeVisible();
    await expect(page.getByTestId("balance")).toHaveText(`$${((before.balanceCents - 5000) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
    expect(orderRow(O.paypalHalf.id).balanceCents).toBe(before.balanceCents - 5000);
    expect(eventTypes(O.paypalHalf.id).find((e) => e.type === "BALANCE_ADJUSTED")).toMatchObject({ actorType: "ADMIN", note: "Descuento por referir a un colega" });

    // Ver un correo enviado y reenviarlo.
    const n = one<{ n: number }>(`SELECT COUNT(*) n FROM EmailOutbox WHERE orderId = ? AND template = 'order_confirmation'`, O.paypalHalf.id).n;
    await page.getByRole("button", { name: "Ver «Confirmación de pedido»" }).click();
    const prev = page.getByRole("dialog").filter({ has: page.locator("iframe") });
    await expect(prev.frameLocator("iframe").locator("body")).toContainText(`${O.paypalHalf.number}`);
    await prev.getByRole("button", { name: "Reenviar correo" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Correo reenviado" })).toBeVisible();
    expect(one<{ n: number }>(`SELECT COUNT(*) n FROM EmailOutbox WHERE orderId = ? AND template = 'order_confirmation'`, O.paypalHalf.id).n).toBe(n + 1);

    // Cancelar un pedido sin pagar: desde «Más acciones», con motivo.
    await page.goto(`/admin/orders/${O.pending.id}`);
    await expect(page.getByTestId("order-status")).toHaveText("Pago pendiente");
    await page.getByRole("button", { name: "Más acciones" }).click();
    await page.getByRole("menuitem", { name: /Cancelar pedido/ }).click();
    const cancel = page.getByRole("dialog", { name: `Cancelar el pedido #${O.pending.number}` });
    await cancel.getByRole("textbox").fill("El médico pidió anular la compra por WhatsApp.");
    await cancel.getByRole("button", { name: "Cancelar pedido" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Pedido cancelado" })).toBeVisible();
    await expect(page.getByTestId("order-status")).toHaveText("Cancelado");
    expect(orderRow(O.pending.id).status).toBe("CANCELLED");

    // Un pedido pagado no se puede cancelar (hay que reembolsar).
    await page.goto(`/admin/orders/${O.paypalPaid.id}`);
    await page.getByRole("button", { name: "Más acciones" }).click();
    await expect(page.getByRole("menuitem", { name: /Cancelar pedido/ })).toBeDisabled();
  });

  test("ficha en móvil: cabecera, pago y cronología sin desbordes", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "solo móvil");
    await login(page, `/admin/orders/${O.monthly.id}`);
    await expect(page.getByRole("heading", { level: 1, name: `Pedido #${O.monthly.number}` })).toBeVisible();
    await expect(page.getByTestId("installments")).toContainText("Pagada");
    await expect(page.getByTestId("timeline")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
