// Panel · Exportar CSV: el diálogo «Exportar» de cada sección descarga su archivo en el formato elegido
// (para Excel: «;», coma decimal y BOM; sin formato: «,» y punto decimal), con el alcance elegido.
//   E2E_LANE=design E2E_PORT=3107 npx playwright test tests/e2e/a5-export.spec.ts
import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { one, q } from "./support/purchase";

async function login(page: Page, next: string) {
  await page.goto(`/admin/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Correo electrónico", { exact: true }).fill("admin@ceium.net");
  await page.getByLabel("Contraseña", { exact: true }).fill("ceium-admin-2026");
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((u) => u.pathname === next.split("?")[0]);
}

/** Abre «Exportar», elige formato (y alcance), descarga y devuelve nombre y líneas del archivo. */
async function exportFrom(page: Page, opts: { title: string; format?: "excel" | "plain"; scope?: RegExp; button?: string }) {
  await page.getByRole("button", { name: opts.button ?? "Exportar", exact: true }).first().click();
  const dlg = page.getByRole("dialog", { name: opts.title });
  await expect(dlg).toBeVisible();
  if (opts.scope) await dlg.getByRole("radio", { name: opts.scope }).check();
  await dlg.getByRole("radio", { name: opts.format === "plain" ? "CSV sin formato" : /^CSV para Excel/ }).check();
  const [download] = await Promise.all([page.waitForEvent("download"), dlg.getByRole("button", { name: "Exportar", exact: true }).click()]);
  await expect(dlg).toBeHidden();
  const text = fs.readFileSync((await download.path())!, "utf8");
  return { name: download.suggestedFilename(), bom: text.startsWith("﻿"), lines: text.replace(/^﻿/, "").split("\r\n").filter(Boolean) };
}

const STAMP = /-\d{4}-\d{2}-\d{2}\.csv$/;

test.describe("panel · exportar CSV", () => {
  test("cada sección descarga su CSV (para Excel y sin formato)", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "el diálogo es el mismo en móvil");
    const sections = [
      { path: "/admin/orders", title: "Exportar pedidos", file: "pedidos-ceium", head: "Pedido;Fecha;Estado;Cliente", count: `SELECT COUNT(*) AS n FROM "Order"` },
      { path: "/admin/customers", title: "Exportar clientes", file: "clientes-ceium", head: "Nombre;Apellido;Correo;Cédula", count: `SELECT COUNT(*) AS n FROM Customer` },
      { path: "/admin/enrollments", title: "Exportar matrículas", file: "matriculas-ceium", head: "Médico;Correo;Cédula;Curso", count: `SELECT COUNT(*) AS n FROM Enrollment` },
      { path: "/admin/certificates", title: "Exportar certificados emitidos", file: "certificados-ceium", head: "Código;Médico;Correo", count: `SELECT COUNT(*) AS n FROM Certificate WHERE status = 'ISSUED'` },
      { path: "/admin/cohorts", title: "Exportar cohortes", file: "cohortes-ceium", head: "Cohorte;Programa;Sede;Inicio", count: `SELECT COUNT(*) AS n FROM Cohort` },
      { path: "/admin/products", title: "Exportar programas", file: "programas-ceium", head: "Programa;Categoría;Estado", count: `SELECT COUNT(*) AS n FROM Product` },
    ];
    await login(page, "/admin/orders");
    for (const s of sections) {
      await page.goto(s.path);
      const x = await exportFrom(page, { title: s.title });
      expect(x.name, s.path).toMatch(new RegExp(`^${s.file}${STAMP.source}`));
      expect(x.bom, s.path).toBe(true);
      expect(x.lines[0], s.path).toContain(s.head);
      expect(x.lines.length - 1, s.path).toBe(Math.min(one<{ n: number }>(s.count).n, 10_000));
    }
    // Sin formato: «,» y sin BOM; recuerda la elección para la próxima vez.
    await page.goto("/admin/products");
    const plain = await exportFrom(page, { title: "Exportar programas", format: "plain" });
    expect(plain.bom).toBe(false);
    expect(plain.lines[0]).toContain("Programa,Categoría,Estado");
    const [first] = q<{ title: string }>(`SELECT title FROM Product ORDER BY position, title LIMIT 1`);
    expect(plain.lines[1]).toContain(first.title);
    await page.getByRole("button", { name: "Exportar", exact: true }).first().click();
    await expect(page.getByRole("dialog", { name: "Exportar programas" }).getByRole("radio", { name: "CSV sin formato" })).toBeChecked();
    await page.keyboard.press("Escape");
  });

  test("alcance: lo que coincide con los filtros y la lista de alumnos de una cohorte", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "el diálogo es el mismo en móvil");
    // Programas filtrados por categoría: solo los talleres.
    await login(page, "/admin/products?category=WORKSHOP");
    const workshops = one<{ n: number }>(`SELECT COUNT(*) AS n FROM Product WHERE category = 'WORKSHOP'`).n;
    const f = await exportFrom(page, { title: "Exportar programas", scope: /que coinciden con los filtros actuales/ });
    expect(f.lines.length - 1).toBe(workshops);
    expect(f.lines.slice(1).every((l) => l.split(";")[1] === "Taller")).toBe(true);
    // El mismo diálogo ofrece también «Todos los programas».
    const all = await exportFrom(page, { title: "Exportar programas", scope: /^Todos los programas$/ });
    expect(all.lines.length - 1).toBe(one<{ n: number }>(`SELECT COUNT(*) AS n FROM Product`).n);

    // Lista de alumnos de una cohorte (ruta directa: cabecera aunque no haya reservas; sin sesión, 401).
    const cohort = one<{ id: string }>(`SELECT id FROM Cohort ORDER BY startDate LIMIT 1`);
    const r = await page.request.get(`/admin/cohorts/${cohort.id}/export?format=excel`);
    expect(r.status()).toBe(200);
    expect(r.headers()["content-disposition"]).toMatch(/attachment; filename="alumnos-.+\.csv"/);
    expect((await r.text()).replace(/^﻿/, "").split("\r\n")[0]).toBe("Médico;Cédula;Correo;Teléfono;Especialidad;Ciudad;Pedido;Estado del pedido;Cupo;Forma de pago;Total USD;Pagado USD;Saldo USD;Reservado el;Confirmado el;Liberado el;Motivo");
    expect((await page.request.get(`/admin/cohorts/no-existe-1234567890/export`)).status()).toBe(404);
    const anon = await page.context().browser()!.newContext();
    for (const p of ["/admin/customers/export", "/admin/enrollments/export", "/admin/certificates/export", "/admin/cohorts/export", "/admin/products/export", `/admin/cohorts/${cohort.id}/export`]) {
      expect((await anon.request.get(new URL(p, page.url()).toString())).status(), p).toBe(401);
    }
    await anon.close();
  });
});
