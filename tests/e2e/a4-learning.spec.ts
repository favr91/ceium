// Panel · Inicio, Matrículas, ficha del cliente y Certificados (pieza a4). Los médicos se crean con los servicios
// de dominio reales (tests/e2e/support/a4-fixture.ts): checkout + PayPal (mock) → matrícula en el mock de Moodle,
// cursos completados en el mock, consulta de progreso (emite el certificado de quien completó todo sin saldo),
// un «mitad y mitad» bloqueado por saldo, un «mes a mes» con 1 curso y un curso suelto con error de Moodle.
//   E2E_LANE=panel E2E_PORT=3103 npx playwright test tests/e2e/a4-learning.spec.ts
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { e2eEnv } from "../../playwright.config";
import { MOODLE, one, q } from "./support/purchase";

type Ref = { customerId: string; orderId: string; number: number };
type Fixture = Record<"progress" | "certified" | "blocked" | "monthly" | "failed", Ref>;

function createFixture(): Fixture {
  const keys = ["DATABASE_URL", "APP_URL", "MAIL_DIR", "PRIVATE_FILES_DIR", "CERTIFICATES_DIR", "MOODLE_URL", "MOODLE_TOKEN", "MOODLE_LOGIN_URL", "PAYPAL_BASE_URL", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"] as const;
  const out = execFileSync("npx", ["tsx", "tests/e2e/support/a4-fixture.ts"], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, ...Object.fromEntries(keys.map((k) => [k, e2eEnv[k]])), NODE_ENV: "production" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 150_000,
  });
  const line = out.split("\n").find((l) => l.startsWith("@@JSON "));
  if (!line) throw new Error(`a4-fixture sin resultado:\n${out}`);
  return JSON.parse(line.slice(7)) as Fixture;
}

async function login(page: Page, next: string) {
  await page.goto(`/admin/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Correo electrónico", { exact: true }).fill("admin@ceium.net");
  await page.getByLabel("Contraseña", { exact: true }).fill("ceium-admin-2026");
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((u) => u.pathname === next.split("?")[0]);
}

const customer = (id: string) => one<{ email: string; firstName: string; lastName: string; moodleUserId: number; notes: string | null }>(`SELECT * FROM Customer WHERE id = ?`, id);
const enrollments = (customerId: string) =>
  q<{ id: string; status: string; moodleCourseId: number; completedAt: number | null }>(`SELECT id, status, moodleCourseId, completedAt FROM Enrollment WHERE customerId = ? ORDER BY moodleCourseId`, customerId);
const certificate = (customerId: string) => one<{ id: string; code: string; status: string; revokeReason: string | null }>(`SELECT id, code, status, revokeReason FROM Certificate WHERE customerId = ?`, customerId);
const toast = (page: Page) => page.locator(".toast").last();

let F: Fixture;
test.beforeAll(() => {
  test.setTimeout(200_000);
  F = createFixture();
});

test.describe("panel · matrículas y certificados", () => {
  test("inicio: métricas con gráfica y pestañas, pendientes enlazados, avance por diplomado", async ({ page }) => {
    await login(page, "/admin");
    await expect(page.getByRole("heading", { level: 1, name: /^(Buenos días|Buenas tardes|Buenas noches), Administrador/ })).toBeVisible();
    const tab = page.getByTestId("metric-completions");
    await expect(page.getByTestId("metric-collected")).toHaveAttribute("aria-selected", "true");
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("img", { name: "Gráfica de Cursos completados por día" })).toBeVisible();
    // Cursos completados hoy (al menos los 5 + 9 + 9 + 1 del fixture).
    const n = Number((await tab.locator(".n").innerText()).replace(/\D/g, ""));
    expect(n).toBeGreaterThanOrEqual(24);

    // Tooltip de la gráfica al pasar el cursor.
    const chart = page.getByTestId("home-chart");
    const box = (await chart.boundingBox())!;
    await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2);
    await expect(page.locator(".hm-tip")).toContainText("periodo anterior");

    // Periodo de 7 días en la URL.
    await page.getByRole("link", { name: "7 días" }).click();
    await expect(page).toHaveURL(/dias=7/);
    await expect(page.getByText("Comparado con los 7 días anteriores")).toBeAttached();

    // Pendientes → Matrículas con error.
    await page.getByRole("link", { name: /matrículas? con error en Moodle/ }).click();
    await expect(page).toHaveURL(/\/admin\/enrollments\?view=FAILED/);
    await expect(page.getByRole("tab", { name: /Con error/ })).toHaveAttribute("aria-selected", "true");

    await page.goto("/admin");
    await expect(page.getByTestId("home-program").first()).toContainText("certificado");
    await expect(page.getByRole("link", { name: /certificados? bloqueados? por saldo/ })).toBeVisible();
  });

  test("matrículas: búsqueda, error de Moodle y reintento, consulta de progreso que marca un curso completado", async ({ page }, info) => {
    const mobile = info.project.name === "mobile";
    const scope = (p: Page) => p.getByTestId(mobile ? "enrollments-list" : "enrollments-table");
    const failed = customer(F.failed.customerId);
    await login(page, "/admin/enrollments");
    await expect(page.getByRole("heading", { level: 1, name: "Matrículas" })).toBeVisible();
    await expect(page.getByTestId("metric-failed")).not.toHaveText("0");

    // Con error + búsqueda por correo (filtra mientras se escribe).
    await page.getByRole("tab", { name: /Con error/ }).click();
    await page.getByRole("button", { name: "Buscar y filtrar" }).click();
    await page.getByLabel("Buscar matrículas").fill(failed.email);
    await expect(page).toHaveURL(/q=/);
    await expect(scope(page)).toContainText(`${failed.firstName} ${failed.lastName}`);
    await expect(scope(page)).toContainText("Error de matrícula");
    await expect(scope(page)).toContainText("enrolnotpermitted");

    // Seleccionar y reintentar: Moodle ya acepta → matriculado.
    await scope(page).getByRole("checkbox").first().check();
    await expect(page.getByRole("region", { name: "Acciones masivas" })).toContainText("1 seleccionada");
    await page.getByRole("button", { name: "Reintentar matrícula" }).click();
    await expect(toast(page)).toContainText("Matrícula reintentada");
    expect(enrollments(F.failed.customerId).map((e) => e.status)).toEqual(["ENROLLED"]);
    await page.getByRole("tab", { name: /^Todas/ }).click();
    await expect(scope(page)).toContainText("En curso");

    // Moodle marca un curso más del médico «progress» → «Consultar progreso en Moodle» lo registra.
    const prog = customer(F.progress.customerId);
    const pending = enrollments(F.progress.customerId).filter((e) => e.completedAt == null);
    expect(pending.length).toBe(4);
    const r = await fetch(`${MOODLE}/__mock/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userid: prog.moodleUserId, courseid: pending[0].moodleCourseId, completed: true }) });
    expect(r.ok).toBe(true);
    await page.getByLabel("Buscar matrículas").fill(prog.email);
    await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(prog.email).replace(/\./g, "\\.")}`));
    await page.getByRole("tab", { name: /En curso/ }).click();
    await expect(scope(page).locator("[data-state]")).toHaveCount(4);
    if (mobile) {
      for (const cb of await scope(page).getByRole("checkbox").all()) await cb.check();
    } else {
      await page.getByRole("checkbox", { name: "Seleccionar todas las matrículas de la página" }).first().check();
    }
    await page.getByRole("button", { name: "Consultar progreso en Moodle" }).click();
    await expect(toast(page)).toContainText("1 completado · 1 nuevo");
    await expect(scope(page).locator("[data-state]")).toHaveCount(3);
    expect(enrollments(F.progress.customerId).filter((e) => e.completedAt != null)).toHaveLength(6);
    await page.getByRole("tab", { name: /Completadas/ }).click();
    await expect(scope(page).locator("[data-state=COMPLETED]")).toHaveCount(6);
  });

  test("ficha del cliente: avance curso a curso, certificado pendiente, nota con auditoría", async ({ page }) => {
    const c = customer(F.progress.customerId);
    await login(page, `/admin/customers/${F.progress.customerId}`);
    await expect(page.getByRole("heading", { level: 1, name: `${c.firstName} ${c.lastName}` })).toBeVisible();
    await expect(page.getByTestId("stat-balance")).toHaveText("$0.00");
    const prog = page.getByTestId("programs");
    await expect(prog.getByTestId("program-progress")).toHaveText(/^\d de 9 cursos$/);
    const done = Number((await prog.getByTestId("program-progress").innerText()).split(" ")[0]);
    await expect(prog.locator("li[data-state=COMPLETED]")).toHaveCount(done);
    await expect(prog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", String(done));
    await expect(page.getByTestId("certificate-strip")).toContainText(`faltan ${9 - done} cursos`);
    // Revisar certificado: Moodle confirma el avance; no se emite.
    await page.getByRole("button", { name: "Revisar certificado" }).click();
    await expect(toast(page)).toContainText(`Moodle reporta ${done} de 9 cursos completados`);
    expect(certificate(F.progress.customerId)).toBeUndefined();
    // Cronología con los eventos del pedido.
    await expect(page.getByTestId("timeline")).toContainText(`#${F.progress.number}`);
    await expect(page.getByTestId("timeline")).toContainText("Matriculado en 9 curso");

    // Nota interna.
    await page.getByRole("button", { name: "Editar nota" }).click();
    await page.getByLabel("Nota del cliente").fill("Prefiere que la llamen por WhatsApp después de las 6 p. m.");
    await page.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByTestId("customer-note")).toHaveText("Prefiere que la llamen por WhatsApp después de las 6 p. m.");
    expect(customer(F.progress.customerId).notes).toBe("Prefiere que la llamen por WhatsApp después de las 6 p. m.");
    expect(one<{ n: number }>(`SELECT COUNT(*) n FROM AuditLog WHERE entityType = 'Customer' AND entityId = ? AND action = 'customer.note'`, F.progress.customerId).n).toBe(1);

    // Mes a mes: 1 curso habilitado, los demás sin habilitar con su cuota.
    await page.goto(`/admin/customers/${F.monthly.customerId}`);
    await expect(page.getByTestId("programs").locator("li[data-state=LOCKED]")).toHaveCount(8);
    await expect(page.getByTestId("programs")).toContainText("cuota 2 pendiente");

    // Bloqueado por saldo: completó todo, el certificado espera el saldo.
    await page.goto(`/admin/customers/${F.blocked.customerId}`);
    await expect(page.getByTestId("program-progress")).toHaveText("9 de 9 cursos");
    await expect(page.getByTestId("certificate-strip")).toContainText("se emite al cancelar el saldo");
    await page.getByRole("button", { name: "Revisar certificado" }).click();
    await expect(toast(page)).toContainText("saldo pendiente");
    expect(certificate(F.blocked.customerId)).toBeUndefined();
  });

  test("certificados: emitido con PDF privado, bloqueado por saldo y revocación con motivo", async ({ page, browser }, info) => {
    const mobile = info.project.name === "mobile";
    const cert = certificate(F.certified.customerId);
    expect(cert.status).toBe("ISSUED");
    await login(page, "/admin/certificates");
    await expect(page.getByRole("heading", { level: 1, name: "Certificados" })).toBeVisible();
    await page.getByRole("button", { name: "Buscar y filtrar" }).click();
    await page.getByLabel("Buscar certificados").fill(cert.code);
    await expect(page).toHaveURL(/q=/);
    const list = page.getByTestId(mobile ? "certificates-list" : "certificates-table");
    await expect(list).toContainText(cert.code);
    await expect(list.locator("li, tbody tr")).toHaveCount(1);

    // PDF: con sesión se descarga; sin sesión 401.
    const res = await page.request.get(`/admin/certificates/${cert.id}/pdf?download=1`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/pdf");
    expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");
    const anon = await browser.newContext();
    expect((await anon.request.get(`${e2eEnv.APP_URL}/admin/certificates/${cert.id}/pdf`)).status()).toBe(401);
    await anon.close();

    // Bloqueados por saldo.
    await page.getByRole("tab", { name: /Bloqueados por saldo/ }).click();
    await page.getByLabel("Buscar certificados").fill(customer(F.blocked.customerId).email);
    await expect(page).toHaveURL(/view=BLOCKED.*q=/);
    await expect(page.getByTestId(mobile ? "progress-list" : "progress-table")).toContainText("9 de 9");

    if (mobile) return; // la revocación se prueba en escritorio (la acción es la misma)
    // Reenviar y revocar.
    await page.getByRole("tab", { name: /Emitidos/ }).click();
    await page.getByLabel("Buscar certificados").fill(cert.code);
    await page.getByRole("button", { name: `Reenviar ${cert.code} por correo` }).click();
    await expect(toast(page)).toContainText("Certificado reenviado");
    expect(one<{ n: number }>(`SELECT COUNT(*) n FROM EmailOutbox WHERE template = 'certificate_issued' AND customerId = ?`, F.certified.customerId).n).toBe(2);
    await page.getByRole("button", { name: `Revocar ${cert.code}` }).click();
    const dlg = page.getByRole("dialog", { name: `Revocar ${cert.code}` });
    await expect(dlg.getByRole("button", { name: "Revocar certificado" })).toBeDisabled();
    await dlg.getByLabel("Motivo").fill("Emitido por error en la prueba");
    await dlg.getByRole("button", { name: "Revocar certificado" }).click();
    await expect(toast(page)).toContainText("revocado");
    expect(certificate(F.certified.customerId)).toMatchObject({ status: "REVOKED", revokeReason: "Emitido por error en la prueba" });
    await page.getByRole("tab", { name: /Revocados/ }).click();
    await expect(page.getByTestId("certificates-table")).toContainText("Emitido por error en la prueba");
  });
});
