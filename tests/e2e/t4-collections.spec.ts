import Database from "better-sqlite3";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { e2eEnv } from "../../playwright.config";
import { one, q } from "./support/purchase";

// t4 — páginas de colección: diplomados (tarjetas anchas PageFly), cursos (rejilla PageFly) y talleres (Dawn).
// Todo sale de la BD: título, productos y orden, notas de inscripción, precios «A partir de», plantilla editable.
// Geometría medida en ceium.net en vivo (1440 × 900 / 390 × 844).
//   E2E_LANE=tienda E2E_PORT=3101 npx playwright test tests/e2e/t4-collections.spec.ts

const DB_FILE = e2eEnv.DATABASE_URL.replace(/^file:/, "");
const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1440) < 750;

/** Escritura puntual en la BD de la app (se restaura siempre en `finally`). */
function exec(sql: string, ...params: unknown[]) {
  const db = new Database(DB_FILE);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}
const sqlDate = (d: Date) => d.toISOString().replace("Z", "+00:00");

async function open(page: Page, slug: string) {
  await page.goto(`/collections/${slug}`);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function box(loc: Locator) {
  const b = await loc.boundingBox();
  if (!b) throw new Error("sin caja");
  const scrollY = await loc.page().evaluate(() => window.scrollY);
  return { x: Math.round(b.x), y: Math.round(b.y + scrollY), w: Math.round(b.width), h: Math.round(b.height) };
}

/** Productos publicados de una colección, en su orden. */
function productsOf(slug: string) {
  return q<{ slug: string; title: string; id: string }>(
    `SELECT p.slug, p.title, p.id FROM CollectionProduct cp JOIN Collection c ON c.id = cp.collectionId JOIN Product p ON p.id = cp.productId
     WHERE c.slug = ? AND p.published = 1 ORDER BY cp.position`,
    slug,
  );
}

const SLUGS = [
  "diplomados",
  "cursos-universitarios",
  "cursos-avanzados",
  "talleres-especializados",
  "cursos-del-diplomado-universitario-avanzado-de-medicina-materno-fetal",
];

test.describe("t4 colecciones", () => {
  for (const slug of SLUGS) {
    test(`${slug}: título y programas de la BD, en orden, enlazados a su ficha`, async ({ page }) => {
      await open(page, slug);
      const { title } = one<{ title: string }>(`SELECT title FROM Collection WHERE slug = ?`, slug);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      await expect(page).toHaveTitle(new RegExp(title));
      const expected = productsOf(slug);
      expect(expected.length).toBeGreaterThan(0);
      const items = page.locator("[data-product]");
      await expect(items).toHaveCount(expected.length);
      expect(await items.evaluateAll((els) => els.map((e) => e.getAttribute("data-product")))).toEqual(expected.map((p) => p.slug));
      for (const [i, p] of expected.entries()) {
        const link = items.nth(i).getByRole("link", { name: p.title, exact: true });
        await expect(link).toHaveAttribute("href", `/products/${p.slug}`);
      }
    });
  }

  test("colección inexistente o despublicada → 404", async ({ page }) => {
    expect((await page.goto("/collections/no-existe"))!.status()).toBe(404);
    exec(`UPDATE Collection SET published = 0 WHERE slug = 'cursos-avanzados'`);
    try {
      expect((await page.goto("/collections/cursos-avanzados"))!.status()).toBe(404);
    } finally {
      exec(`UPDATE Collection SET published = 1 WHERE slug = 'cursos-avanzados'`);
    }
  });

  test("diplomados: modalidad, nota, extracto y «Inscríbete» con la geometría de ceium.net", async ({ page }) => {
    await open(page, "diplomados");
    const mobile = isMobile(page);
    await expect(page.locator(".coll-diplomas__text")).toContainText("Nuestros diplomados te capacitarán");
    const rows = q<{ slug: string; enrollmentNote: string; excerpt: string; offersOnline: number; offersSemipresencial: number }>(
      `SELECT p.slug, p.enrollmentNote, p.excerpt, p.offersOnline, p.offersSemipresencial FROM CollectionProduct cp
       JOIN Collection c ON c.id = cp.collectionId JOIN Product p ON p.id = cp.productId WHERE c.slug = 'diplomados' AND p.published = 1 ORDER BY cp.position`,
    );
    for (const r of rows) {
      const card = page.locator(`[data-product="${r.slug}"]`);
      await expect(card.locator(".coll-diploma__badge")).toHaveText(r.offersOnline && r.offersSemipresencial ? "Online y semipresencial" : /Online|Semipresencial/);
      await expect(card.locator(".coll-diploma__badge")).toHaveCSS("text-transform", "uppercase");
      await expect(card.locator(".coll-diploma__note")).toHaveText(r.enrollmentNote);
      await expect(card.locator(".coll-diploma__excerpt")).toHaveText(r.excerpt);
      await expect(card.getByRole("link", { name: /^Inscríbete:/ })).toHaveAttribute("href", `/products/${r.slug}`);
    }
    const first = page.locator(".coll-diploma").first();
    const c = await box(first);
    const img = await box(first.locator(".coll-diploma__media"));
    const btn = await box(first.locator(".coll-btn"));
    if (mobile) {
      expect(c).toMatchObject({ x: 15, y: 343, w: 360 });
      expect(img).toMatchObject({ x: 32, y: 360, w: 326, h: 184 });
      expect(btn).toMatchObject({ x: 32, w: 326, h: 46 });
    } else {
      expect(c).toMatchObject({ x: 135, y: 339, w: 1170, h: 350 });
      expect(img).toMatchObject({ x: 176, y: 380, w: 433, h: 245 });
      expect(btn).toMatchObject({ x: 649, y: 602, w: 137, h: 46 });
    }
    await expect(first).toHaveCSS("border-radius", mobile ? "20px" : "24px");
  });

  test("cursos: rejilla de 4 (escritorio) / 2 (móvil) columnas con las medidas de ceium.net", async ({ page }) => {
    await open(page, "cursos-avanzados");
    const mobile = isMobile(page);
    await expect(page.locator(".coll-eyebrow")).toHaveText("¡Inscripciones abiertas!");
    const cards = page.locator(".coll-card");
    const boxes = await Promise.all([0, 1, 2, 3].map((i) => box(cards.nth(i))));
    if (mobile) {
      expect(boxes.map((b) => [b.x, b.y, b.w])).toEqual([
        [15, 257, 175],
        [200, 257, 175],
        [15, 556, 175],
        [200, 556, 175],
      ]);
      expect(await box(cards.first().locator(".coll-card__btn"))).toMatchObject({ x: 26, y: 494, w: 153, h: 41 });
    } else {
      expect(boxes.map((b) => [b.x, b.y, b.w])).toEqual([
        [135, 352, 281],
        [432, 352, 281],
        [728, 352, 281],
        [1025, 352, 281],
      ]);
      expect(boxes[0].h).toBe(334);
      expect(await box(cards.first().locator(".coll-card__btn"))).toMatchObject({ x: 152, y: 628, w: 107, h: 41 });
    }
    // Cursos avanzados muestran solo el estado de inscripción, como ceium.net.
    await expect(page.locator(".coll-card__note").first()).toHaveText("✍ Inscripciones abiertas.");
  });

  test("nota de cada curso: la del programa, fecha límite futura o «Inscripciones cerradas»", async ({ page }) => {
    const slug = "cursos-universitarios";
    const [a, b] = productsOf(slug);
    const before = q<{ id: string; enrollmentNote: string | null; eventDateText: string | null; enrollmentDeadline: string | null }>(
      `SELECT id, enrollmentNote, eventDateText, enrollmentDeadline FROM Product WHERE id IN (?, ?)`,
      a.id,
      b.id,
    );
    const future = new Date(Date.now() + 40 * 86400_000);
    future.setUTCHours(4, 0, 0, 0); // 00:00 en Venezuela
    try {
      exec(`UPDATE Product SET enrollmentNote = NULL, eventDateText = NULL, enrollmentDeadline = ? WHERE id = ?`, sqlDate(future), a.id);
      exec(`UPDATE Product SET enrollmentDeadline = ? WHERE id = ?`, sqlDate(new Date(Date.now() - 3 * 86400_000)), b.id);
      await open(page, slug);
      const dd = new Intl.DateTimeFormat("es-VE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Caracas" }).format(future);
      const cardA = page.locator(`[data-product="${a.slug}"]`);
      await expect(cardA.locator(".coll-card__note")).toHaveText(`Inscripción hasta: ${dd}`);
      await expect(cardA.getByRole("link", { name: `Inscríbete: ${a.title}` })).toBeVisible();
      // La fecha baja 15 px pero el botón queda alineado con el de la tarjeta vecina.
      const cardB = page.locator(`[data-product="${b.slug}"]`);
      await expect(cardB.locator(".coll-card__note")).toHaveText("Inscripciones cerradas");
      await expect(cardB.getByRole("link", { name: `Ver programa: ${b.title}` })).toHaveAttribute("href", `/products/${b.slug}`);
      // (En móvil la fecha ocupa dos líneas en 153 px, como la de ceium.net.)
      if (!isMobile(page)) expect((await box(cardA.locator(".coll-card__btn"))).y).toBe((await box(cardB.locator(".coll-card__btn"))).y);
    } finally {
      for (const r of before) exec(`UPDATE Product SET enrollmentNote = ?, eventDateText = ?, enrollmentDeadline = ? WHERE id = ?`, r.enrollmentNote, r.eventDateText, r.enrollmentDeadline, r.id);
    }
  });

  test("un programa despublicado desaparece de la colección", async ({ page }) => {
    const [first] = productsOf("cursos-avanzados");
    exec(`UPDATE Product SET published = 0 WHERE id = ?`, first.id);
    try {
      await open(page, "cursos-avanzados");
      await expect(page.locator(`[data-product="${first.slug}"]`)).toHaveCount(0);
      await expect(page.locator(".coll-card")).toHaveCount(productsOf("cursos-avanzados").length);
    } finally {
      exec(`UPDATE Product SET published = 1 WHERE id = ?`, first.id);
    }
  });

  test("talleres (Dawn): tarjeta cuadrada y «A partir de» = menor primer pago de la BD", async ({ page }) => {
    await open(page, "talleres-especializados");
    const mobile = isMobile(page);
    for (const p of productsOf("talleres-especializados")) {
      const prices = q<{ priceCents: number }>(`SELECT priceCents FROM PriceEntry WHERE productId = ? AND active = 1`, p.id);
      const plans = q<{ kind: string; discountPct: number }>(`SELECT kind, discountPct FROM PaymentPlan WHERE productId = ? AND active = 1`, p.id);
      const min = Math.min(
        ...prices.flatMap((pr) =>
          (plans.length ? plans : [{ kind: "FULL", discountPct: 0 }]).map((pl) => {
            const total = pr.priceCents - Math.round((pr.priceCents * pl.discountPct) / 100);
            return pl.kind === "HALF" ? Math.ceil(total / 2) : total;
          }),
        ),
      );
      const text = `A partir de $${(min / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} USD`;
      await expect(page.locator(`[data-product="${p.slug}"] .card__price`)).toHaveText(text);
    }
    // Precios reales de ceium.net.
    await expect(page.locator(".card__price")).toHaveText([
      "A partir de $140.00 USD",
      "A partir de $175.00 USD",
      "A partir de $200.00 USD",
      "A partir de $300.00 USD",
    ]);
    const media = await box(page.locator(".card__media").first());
    expect(media).toEqual(mobile ? { x: 15, y: 242, w: 176, h: 176 } : { x: 120, y: 254, w: 288, h: 288 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-size", mobile ? "30px" : "40px");
    // Dawn reparte interletra a todo el cromo; las páginas PageFly la anulan.
    await expect(page.locator(".announcement-bar__message").first()).toHaveCSS("letter-spacing", "1px");
    await expect(page.locator(".footer")).toHaveCSS("letter-spacing", "0.6px");
    await open(page, "diplomados");
    await expect(page.locator(".announcement-bar__message").first()).toHaveCSS("letter-spacing", /^(0px|normal)$/);
    await expect(page.locator(".footer")).toHaveCSS("letter-spacing", /^(0px|normal)$/);
  });

  test("hover: la tarjeta sube 5 px con sombra y el título se subraya", async ({ page, isMobile: touch }) => {
    test.skip(touch, "sin hover en táctil");
    await open(page, "cursos-universitarios");
    const card = page.locator(".coll-card").first();
    await card.hover();
    await expect(card).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, -5)");
    await expect(card).not.toHaveCSS("box-shadow", "none");
    await card.locator(".coll-card__title a").hover();
    await expect(card.locator(".coll-card__title a")).toHaveCSS("text-decoration-line", "underline");
    const btn = card.locator(".coll-card__btn");
    await btn.hover();
    await expect(btn).toHaveCSS("background-color", "rgb(8, 154, 154)");
  });

  test("la plantilla es editable por colección con la Setting store.collections", async ({ page }) => {
    const prev = one<{ value: string } | undefined>(`SELECT value FROM Setting WHERE key = 'store.collections'`);
    const value = JSON.stringify({ "cursos-avanzados": { template: "grid" }, "talleres-especializados": { template: "cards", eyebrow: "Nuevas fechas" } });
    exec(
      `INSERT INTO Setting (key, value, updatedAt) VALUES ('store.collections', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      value,
      sqlDate(new Date()),
    );
    try {
      await open(page, "cursos-avanzados");
      await expect(page.locator(".coll-dawn .card__price").first()).toHaveText(/^A partir de \$/);
      await open(page, "talleres-especializados");
      await expect(page.locator(".coll-eyebrow")).toHaveText("Nuevas fechas");
      await expect(page.locator(".coll-card")).toHaveCount(productsOf("talleres-especializados").length);
      // Talleres con fechas: la nota es la fecha del evento.
      const facial = one<{ eventDateText: string }>(`SELECT eventDateText FROM Product WHERE slug = 'taller-de-ecografia-facial'`);
      await expect(page.locator('[data-product="taller-de-ecografia-facial"] .coll-card__note')).toHaveText(facial.eventDateText);
    } finally {
      if (prev) exec(`UPDATE Setting SET value = ? WHERE key = 'store.collections'`, prev.value);
      else exec(`DELETE FROM Setting WHERE key = 'store.collections'`);
    }
  });
});
