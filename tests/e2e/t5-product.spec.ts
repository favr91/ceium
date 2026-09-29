import Database from "better-sqlite3";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { e2eEnv } from "../../playwright.config";
import { one, q } from "./support/purchase";

// t5 — ficha de producto: contenido desde la BD, opciones de ceium.net (modalidad, sede, forma de pago) + cohorte
// con fechas y cupos en vivo, precio que cambia al instante, cohortes llenas no comprables, agregar al carrito.
// Geometría medida en ceium.net en vivo (1440 × 900 / 390 × 844).
//   E2E_LANE=tienda E2E_PORT=3101 npx playwright test tests/e2e/t5-product.spec.ts

const DB_FILE = e2eEnv.DATABASE_URL.replace(/^file:/, "");
const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1440) < 750;

const DIPLOMA = "diplomado-universitario-avanzado-de-medicina-materno-fetal";
const COURSE = "curso-universitario-ecografia-obstetrica";
const WORKSHOP = "taller-de-ecografia-facial";

function exec(sql: string, ...params: unknown[]) {
  const db = new Database(DB_FILE);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

const usd = (cents: number) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function product(slug: string) {
  return one<{ id: string; title: string; faculty: string; requirements: string }>(`SELECT id, title, faculty, requirements FROM Product WHERE slug = ?`, slug)!;
}
function price(slug: string, modality: string, sede: string | null) {
  return one<{ priceCents: number; installmentCents: number | null }>(
    `SELECT pe.priceCents, pe.installmentCents FROM PriceEntry pe JOIN Product p ON p.id = pe.productId LEFT JOIN Sede s ON s.id = pe.sedeId
     WHERE p.slug = ? AND pe.modality = ? AND ${sede ? "s.name = ?" : "pe.sedeId IS NULL"}`,
    ...[slug, modality, ...(sede ? [sede] : [])],
  )!;
}
function plan(slug: string, kind: string) {
  return one<{ label: string; discountPct: number }>(`SELECT pp.label, pp.discountPct FROM PaymentPlan pp JOIN Product p ON p.id = pp.productId WHERE p.slug = ? AND pp.kind = ?`, slug, kind)!;
}
function cohorts(slug: string, sede: string) {
  return q<{ id: string; name: string; capacity: number; seatsConfirmed: number }>(
    `SELECT c.id, c.name, c.capacity, c.seatsConfirmed FROM Cohort c JOIN Product p ON p.id = c.productId JOIN Sede s ON s.id = c.sedeId
     WHERE p.slug = ? AND s.name = ? AND c.status = 'OPEN' ORDER BY c.startDate`,
    slug,
    sede,
  );
}

async function open(page: Page, slug: string) {
  await page.goto(`/products/${slug}`);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function box(loc: Locator) {
  const b = await loc.boundingBox();
  if (!b) throw new Error("sin caja");
  const scrollY = await loc.page().evaluate(() => window.scrollY);
  return { x: Math.round(b.x), y: Math.round(b.y + scrollY), w: Math.round(b.width), h: Math.round(b.height) };
}

const form = (page: Page) => page.getByTestId("buy-form");
const radio = (page: Page, group: string, name: string | RegExp) => form(page).getByRole("group", { name: group }).getByRole("radio", { name });
const priceEl = (page: Page) => page.getByTestId("price");

test.describe("t5 ficha de producto", () => {
  test.afterEach(async ({ context }) => {
    await context.clearCookies();
  });

  test("contenido del diplomado sale de la BD (datos, docentes, cronogramas, cursos, relacionados)", async ({ page }) => {
    const p = product(DIPLOMA);
    await open(page, DIPLOMA);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(p.title);
    await expect(page.locator(".pp-info")).toContainText(p.requirements);
    for (const name of JSON.parse(p.faculty) as string[]) await expect(page.locator(".pp-faculty")).toContainText(name);
    // Cronogramas → ficha en vivo de la cohorte (no PDF).
    const sched = page.locator(".pp-schedules a").first();
    await expect(sched).toHaveAttribute("href", new RegExp(`^/cronograma/${DIPLOMA}/`));
    // «Cursos de este diplomado»: acordeón cerrado que se abre y lista los cursos del diplomado, en orden.
    const courses = q<{ title: string }>(`SELECT c.title FROM DiplomaCourse dc JOIN Product c ON c.id = dc.courseId WHERE dc.diplomaId = ? ORDER BY dc.position`, p.id);
    const acc = page.locator("details", { has: page.getByRole("heading", { name: "Cursos de este diplomado" }) });
    await expect(acc).not.toHaveAttribute("open", "");
    await acc.locator("summary").click();
    await expect(acc.locator(".pp-dcourses > li")).toHaveCount(courses.length);
    await expect(acc.locator(".pp-dcourses > li").first()).toContainText(courses[0].title);
    // Carrusel «Cursos del Diplomado …» con los mismos cursos y «Conoce más» → su colección.
    await expect(page.locator(".pp-related .pp-rcard")).toHaveCount(courses.length);
    await expect(page.getByRole("link", { name: "Conoce más" })).toHaveAttribute("href", `/collections/cursos-del-${DIPLOMA}`);
  });

  test("vista previa al compartir: og:image absoluta (1200 px) y título del programa", async ({ page }) => {
    await page.goto(`/products/${COURSE}`);
    const og = await page.locator('meta[property="og:image"]').getAttribute("content");
    expect(og).toMatch(/^https:\/\/.+[?&]width=1200$/);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", product(COURSE).title);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", new RegExp(`^https?://[^/]+/products/${COURSE}$`));
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
  });

  test("el precio cambia al instante con modalidad, sede y forma de pago", async ({ page }) => {
    await open(page, DIPLOMA);
    const bqto = price(DIPLOMA, "SEMIPRESENCIAL", "Barquisimeto");
    const ccs = price(DIPLOMA, "SEMIPRESENCIAL", "Caracas");
    const online = price(DIPLOMA, "ONLINE", null);
    const n = q(`SELECT 1 FROM DiplomaCourse dc JOIN Product p ON p.id = dc.diplomaId WHERE p.slug = ?`, DIPLOMA).length;

    // Por defecto: Semipresencial · Barquisimeto · «Paga mes a mes» (como ceium.net): una cuota.
    await expect(radio(page, "Modalidad", "Semipresencial")).toBeChecked();
    await expect(radio(page, "Sede", "Barquisimeto")).toBeChecked();
    await expect(priceEl(page)).toHaveText(usd(bqto.installmentCents!));
    await expect(page.getByTestId("price-summary")).toContainText(`${n} cuotas`);

    await radio(page, "Sede", "Caracas").check();
    await expect(priceEl(page)).toHaveText(usd(ccs.installmentCents!));

    const full = plan(DIPLOMA, "FULL");
    await radio(page, "Forma de pago", full.label).check();
    const fullTotal = ccs.priceCents - Math.round((ccs.priceCents * full.discountPct) / 100);
    await expect(priceEl(page)).toHaveText(usd(fullTotal));
    await expect(page.getByTestId("price-summary")).toContainText(`Ahorras ${usd(ccs.priceCents - fullTotal)}`);

    const half = plan(DIPLOMA, "HALF");
    await radio(page, "Forma de pago", half.label).check();
    const halfTotal = ccs.priceCents - Math.round((ccs.priceCents * half.discountPct) / 100);
    await expect(priceEl(page)).toHaveText(usd(Math.ceil(halfTotal / 2)));

    // Online: sin sede ni cohorte, precio online.
    await radio(page, "Modalidad", "Online").check();
    await expect(form(page).getByRole("group", { name: "Sede" })).toHaveCount(0);
    await expect(form(page).getByRole("group", { name: "Cohorte" })).toHaveCount(0);
    await expect(priceEl(page)).toHaveText(usd(Math.ceil((online.priceCents - Math.round((online.priceCents * half.discountPct) / 100)) / 2)));
  });

  test("cohortes con fechas y cupos; las llenas se ven pero no se pueden comprar", async ({ page }) => {
    const rows = cohorts(COURSE, "Barquisimeto");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const [first, second] = rows;
    try {
      // La primera cohorte se llena: aparece «Agotado», deshabilitada, y se preselecciona la siguiente.
      exec(`UPDATE Cohort SET seatsConfirmed = capacity WHERE id = ?`, first.id);
      exec(`UPDATE Cohort SET seatsConfirmed = capacity - 3 WHERE id = ?`, second.id);
      await open(page, COURSE);
      const group = form(page).getByRole("group", { name: "Cohorte" });
      const full = group.locator(`[data-cohort="${first.name}"]`);
      await expect(full).toHaveAttribute("data-phase", "SOLD_OUT");
      await expect(full).toContainText("Agotado");
      await expect(full.getByRole("radio")).toBeDisabled();
      const next = group.locator(`[data-cohort="${second.name}"]`);
      await expect(next.getByRole("radio")).toBeChecked();
      await expect(next).toContainText("¡Quedan 3 cupos!");
      await expect(form(page).getByRole("button", { name: "Agregar al carrito" })).toBeEnabled();

      // Toda la sede llena: la sede lo dice, el botón queda en «Agotado» y se sugieren otras sedes / online.
      exec(`UPDATE Cohort SET seatsConfirmed = capacity WHERE id = ?`, second.id);
      await open(page, COURSE);
      await expect(radio(page, "Sede", /Barquisimeto/)).toBeChecked({ checked: false });
      await radio(page, "Sede", /Barquisimeto/).check();
      await expect(form(page).locator(".pp-radio", { hasText: "Barquisimeto" })).toContainText("sin cupos");
      await expect(form(page).getByRole("button", { name: "Agotado" })).toBeDisabled();
      await expect(form(page).locator(".pp-opt__help")).toContainText("No quedan cupos en Barquisimeto");
      await expect(form(page).locator(".pp-opt__help")).toContainText("Caracas");
    } finally {
      exec(`UPDATE Cohort SET seatsConfirmed = ? WHERE id = ?`, first.seatsConfirmed, first.id);
      exec(`UPDATE Cohort SET seatsConfirmed = ? WHERE id = ?`, second.seatsConfirmed, second.id);
    }
  });

  test("agregar al carrito lleva la modalidad, sede, cohorte y forma de pago elegidas a /cart", async ({ page }) => {
    const [, second] = cohorts(COURSE, "Caracas");
    await open(page, COURSE);
    await radio(page, "Sede", "Caracas").check();
    await form(page).getByRole("group", { name: "Cohorte" }).locator(`[data-cohort="${second.name}"]`).click();
    const half = plan(COURSE, "HALF");
    await radio(page, "Forma de pago", half.label).check();
    await expect(priceEl(page)).toHaveText(usd(Math.ceil(price(COURSE, "SEMIPRESENCIAL", "Caracas").priceCents / 2)));
    await form(page).getByRole("button", { name: "Agregar al carrito" }).click();
    await page.waitForURL(/\/cart(\?|$)/);
    const main = page.locator("main");
    await expect(main).toContainText(product(COURSE).title);
    await expect(main).toContainText("Caracas");
    await expect(main).toContainText(second.name.replace(/^Cohorte\s+/i, "")); // el carrito rotula «Cohorte: Noviembre 2026»
    await expect(main).toContainText(half.label);
  });

  test("si la cohorte se llena mientras el médico decide, el servidor lo rechaza y se avisa", async ({ page }) => {
    const [c] = cohorts(WORKSHOP, "Barquisimeto");
    try {
      await open(page, WORKSHOP);
      await expect(form(page).locator(`[data-cohort="${c.name}"] input`)).toBeChecked();
      exec(`UPDATE Cohort SET seatsConfirmed = capacity WHERE id = ?`, c.id);
      await form(page).getByRole("button", { name: "Agregar al carrito" }).click();
      await expect(form(page).getByRole("alert")).toContainText("cupos");
      await expect(page).toHaveURL(new RegExp(`/products/${WORKSHOP}`));
    } finally {
      exec(`UPDATE Cohort SET seatsConfirmed = ? WHERE id = ?`, c.seatsConfirmed, c.id);
    }
  });

  test("curso: temario abierto, «Pertenece al» y relacionados sin el propio curso", async ({ page }) => {
    await open(page, COURSE);
    const acc = page.locator("details", { has: page.getByRole("heading", { name: "Temas a tratar" }) });
    await expect(acc).toHaveAttribute("open", "");
    await expect(acc).toContainText("Tema 0");
    await expect(page.locator(".pp-fact--belongs a")).toHaveAttribute("href", /\/collections\/cursos-del-diplomado-/);
    await expect(page.getByRole("heading", { name: "Cursos relacionados" })).toBeVisible();
    await expect(page.locator(`.pp-related a[href="/products/${COURSE}"]`)).toHaveCount(0);
    await expect(page.locator(".pp-related .pp-rcard").first()).toBeVisible();
  });

  test("geometría de ceium.net y sin desborde horizontal", async ({ page }) => {
    await open(page, DIPLOMA);
    const mobile = isMobile(page);
    const heroBox = await box(page.locator(".pp-hero__box"));
    const img = await box(page.locator(".pp-media__track"));
    const title = await box(page.locator(".pp-title"));
    const btn = await box(form(page).locator(".pp-btn"));
    if (mobile) {
      expect(heroBox).toMatchObject({ x: 15, w: 360 });
      expect(img).toMatchObject({ x: 32, w: 326 });
      expect(Math.abs(img.h - 184)).toBeLessThanOrEqual(1);
      expect(title.x).toBe(32);
      expect(btn.h).toBe(40);
    } else {
      expect(heroBox).toMatchObject({ x: 135, y: 188, w: 1170 });
      expect(img).toMatchObject({ x: 176, y: 229, w: 514, h: 290 });
      expect(title).toMatchObject({ x: 750, y: 229, w: 514 });
      expect(btn).toMatchObject({ x: 750, w: 165, h: 52 });
      const cells = page.locator(".pp-info__item");
      await expect(cells).toHaveCount(4);
      expect((await box(cells.first())).w).toBe(293);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
