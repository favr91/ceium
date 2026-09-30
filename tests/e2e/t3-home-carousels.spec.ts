import Database from "better-sqlite3";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { e2eEnv } from "../../playwright.config";
import { one, q } from "./support/purchase";

// t3 — home: bloque de diplomados (cronogramas → ficha en vivo de la cohorte), carruseles por colección,
// testimonios en video, galería y llamada final. Geometría medida en ceium.net en vivo (1440 × 900 / 390 × 844).
//   E2E_LANE=tienda E2E_PORT=3101 npx playwright test tests/e2e/t3-home-carousels.spec.ts

const DIPLOMA_SLUG = "diplomado-universitario-de-ecografia-integral-en-el-diagnostico-medico";
const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1440) < 750;

async function open(page: Page) {
  await page.goto("/");
  await page.locator(".section-header[data-ready]").waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function box(loc: Locator) {
  const b = await loc.boundingBox();
  if (!b) throw new Error("sin caja");
  const scrollY = await loc.page().evaluate(() => window.scrollY);
  return { x: Math.round(b.x), y: Math.round(b.y + scrollY), w: Math.round(b.width * 10) / 10, h: Math.round(b.height) };
}

const row = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const scrollLeft = (track: Locator) => track.evaluate((el) => Math.round(el.scrollLeft));

/** Cupos libres en vivo de una cohorte, con la misma regla que el checkout (confirmados + reservas vivas). */
function freeSeats(cohortId: string): number {
  const c = one<{ capacity: number; seatsConfirmed: number }>(`SELECT capacity, seatsConfirmed FROM Cohort WHERE id = ?`, cohortId);
  const held = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM SeatReservation WHERE cohortId = ? AND status = 'HELD' AND expiresAt >= ?`,
    cohortId,
    new Date().toISOString(),
  ).n;
  return Math.max(0, c.capacity - c.seatsConfirmed - held);
}

test.describe("t3 home: diplomados y carruseles", () => {
  test("«Cronograma Cohorte …» abre la ficha en vivo de la cohorte (sedes, fechas, clases, cupos)", async ({ page }) => {
    await open(page);
    const card = page.getByRole("region", { name: "Diplomados" }).locator(".home-diploma").first();
    // Una entrada por cohorte vigente (aunque se dicte en 3 sedes), en orden de inicio; nada de PDF.
    const names = q<{ name: string }>(
      `SELECT DISTINCT c.name FROM Cohort c JOIN Product p ON p.id = c.productId WHERE p.slug = ? AND c.status IN ('OPEN','CLOSED','IN_PROGRESS') ORDER BY c.startDate`,
      DIPLOMA_SLUG,
    ).map((r) => `Cronograma ${r.name.replace(/\s*-\s*/, " ")}`);
    const links = card.locator(".home-diploma__schedules a");
    await expect(links).toHaveText(names);
    for (const a of await links.all()) {
      await expect(a).toHaveAttribute("href", new RegExp(`^/cronograma/${DIPLOMA_SLUG}/cohorte-`));
      await expect(a).not.toHaveAttribute("target", /.*/);
    }

    await card.getByRole("link", { name: "Cronograma Cohorte II 2026" }).click();
    await expect(page).toHaveURL(`/cronograma/${DIPLOMA_SLUG}/cohorte-ii-2026`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cronograma Cohorte II 2026");
    await expect(page.locator(".cron-hero__product")).toHaveText("Diplomado Universitario de Ecografía Integral en el Diagnóstico Médico");

    const rows = q<{ id: string; sede: string; capacity: number }>(
      `SELECT c.id, s.name AS sede, c.capacity FROM Cohort c JOIN Product p ON p.id = c.productId JOIN Sede s ON s.id = c.sedeId
       WHERE p.slug = ? AND c.name = 'Cohorte II - 2026' ORDER BY s.position`,
      DIPLOMA_SLUG,
    );
    const sedes = page.locator(".cron-sede");
    await expect(sedes.locator(".cron-sede__name")).toHaveText(rows.map((r) => r.sede));
    for (const [i, r] of rows.entries()) {
      await expect(sedes.nth(i).getByTestId("cupos")).toHaveText(String(freeSeats(r.id)));
      await expect(sedes.nth(i)).toContainText(`de ${r.capacity}`);
      await expect(sedes.nth(i).getByText("Inscripciones abiertas")).toBeVisible();
    }
    // Calendario: las 9 clases del diplomado (una por curso), en orden.
    const sessions = page.locator(".cron-session");
    await expect(sessions).toHaveCount(9);
    await expect(sessions.first()).toContainText("Curso Universitario: Ecografía de Abdomen");
    await expect(sessions.first().locator("time")).toHaveAttribute("datetime", "2026-10-03");
    // Salto a la otra cohorte vigente del mismo diplomado.
    await page.getByRole("navigation", { name: "Otras cohortes" }).getByRole("link", { name: "Cronograma Cohorte I 2026" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cronograma Cohorte I 2026");
  });

  test("los cupos de la ficha son en vivo y una cohorte inexistente da 404", async ({ page }) => {
    const c = one<{ id: string; seatsConfirmed: number; capacity: number }>(
      `SELECT c.id, c.seatsConfirmed, c.capacity FROM Cohort c JOIN Product p ON p.id = c.productId JOIN Sede s ON s.id = c.sedeId
       WHERE p.slug = ? AND c.name = 'Cohorte II - 2026' AND s.slug = 'maracaibo'`,
      DIPLOMA_SLUG,
    );
    const url = `/cronograma/${DIPLOMA_SLUG}/cohorte-ii-2026`;
    const maracaibo = page.locator(".cron-sede", { hasText: "Maracaibo" });
    await page.goto(url);
    const before = freeSeats(c.id);
    await expect(maracaibo.getByTestId("cupos")).toHaveText(String(before));

    // Se venden 3 cupos (contador de confirmados) → la ficha lo refleja al recargar, sin caché.
    const db = new Database(e2eEnv.DATABASE_URL.replace(/^file:/, ""));
    db.pragma("busy_timeout = 5000");
    try {
      db.prepare(`UPDATE Cohort SET seatsConfirmed = seatsConfirmed + 3 WHERE id = ?`).run(c.id);
      await page.reload();
      await expect(maracaibo.getByTestId("cupos")).toHaveText(String(before - 3));
      // Cohorte llena → «Cupos agotados» y sin botón de inscripción.
      db.prepare(`UPDATE Cohort SET seatsConfirmed = capacity WHERE id = ?`).run(c.id);
      await page.reload();
      await expect(maracaibo.getByText("Cupos agotados")).toBeVisible();
      await expect(maracaibo.getByRole("link", { name: /Inscríbete/ })).toHaveCount(0);
    } finally {
      db.prepare(`UPDATE Cohort SET seatsConfirmed = ? WHERE id = ?`).run(c.seatsConfirmed, c.id);
      db.close();
    }

    const res = await page.goto(`/cronograma/${DIPLOMA_SLUG}/cohorte-xx-1999`);
    expect(res?.status()).toBe(404);
  });

  test("carrusel de cursos: flechas de a 2 tarjetas (1 en móvil), snap, teclado y extremos", async ({ page }) => {
    await open(page);
    const carousel = row(page, "Cursos Universitarios Fundamentales");
    await carousel.scrollIntoViewIfNeeded();
    const track = carousel.locator(".home-carousel__track");
    const prev = carousel.getByRole("button", { name: "Anterior" });
    const next = carousel.getByRole("button", { name: "Siguiente" });
    const cards = track.locator(".home-card");
    const pitch = await cards.evaluateAll((els) => (els[1] as HTMLElement).offsetLeft - (els[0] as HTMLElement).offsetLeft);
    expect(pitch).toBe(isMobile(page) ? 231 : 267);
    const perClick = isMobile(page) ? 1 : 2;

    await expect(prev).toBeHidden();
    await next.click();
    await expect.poll(() => scrollLeft(track)).toBe(perClick * pitch);
    await expect(prev).toBeVisible();
    await next.click();
    await expect.poll(() => scrollLeft(track)).toBe(2 * perClick * pitch);
    await prev.click();
    await expect.poll(() => scrollLeft(track)).toBe(perClick * pitch);

    // Arrastre/rueda nativos: un desplazamiento suelto queda alineado a una tarjeta (scroll-snap obligatorio).
    await track.evaluate((el, by) => el.scrollBy({ left: by, behavior: "instant" }), Math.round(pitch * 0.7));
    await expect.poll(async () => (await scrollLeft(track)) % pitch).toBe(0);

    // Teclado: la pista recibe foco y se mueve con las flechas.
    await track.evaluate((el) => el.scrollTo({ left: 0, behavior: "instant" }));
    await expect(prev).toBeHidden();
    await track.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => scrollLeft(track)).toBeGreaterThan(0);

    // Al final, «Siguiente» desaparece; todas las tarjetas son alcanzables.
    await track.evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: "instant" }));
    await expect(next).toBeHidden();
    await expect(cards.last()).toBeInViewport();
  });

  test("geometría de los carruseles y tarjetas igual a ceium.net", async ({ page }) => {
    await open(page);
    const first = row(page, "Cursos y talleres que inician de marzo a junio de 2026");
    const track = first.locator(".home-carousel__track");
    const trackBox = await box(track);
    const next = await box(first.getByRole("button", { name: "Siguiente" }));
    const cards = track.locator(".home-card");
    const heights = await cards.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    // «Equal height» de PageFly: todas las tarjetas de la fila miden lo que la primera.
    expect(new Set(heights).size).toBe(1);
    const wide = row(page, "Cursos Avanzados").locator(".home-card");
    if (isMobile(page)) {
      // Área visible 10 → 380 px, tarjetas de 221 px desde x = 15, flecha a 20 px del borde.
      expect(trackBox).toMatchObject({ x: 10, w: 370 });
      expect(next).toMatchObject({ x: 320, w: 40, h: 40 });
      expect(await box(cards.first())).toMatchObject({ x: 15, w: 221, h: 306 });
      // Filas anchas en móvil: sin nota de inscripción, igual que ceium.net.
      await expect(wide.first().locator(".home-card__note")).toBeHidden();
      expect(await box(wide.first())).toMatchObject({ w: 221, h: 282 });
    } else {
      expect(trackBox).toMatchObject({ x: 127, w: 1186 });
      expect(next).toMatchObject({ x: 1253, w: 40, h: 40 });
      expect(await box(cards.first())).toMatchObject({ x: 135, w: 251, h: 326 });
      // Filas anchas: 4 columnas de 280,5 px, alto según contenido y nota de estado de inscripción.
      const w = await box(wide.first());
      expect(w).toMatchObject({ x: 135, w: 280.5, h: 305 });
      await expect(wide.first().locator(".home-card__note")).toHaveText("✍ Inscripciones abiertas");
    }
    // Las flechas: gris translúcido en reposo, negro al pasar el mouse.
    const btn = first.getByRole("button", { name: "Siguiente" });
    await expect(btn).toHaveCSS("background-color", "rgba(0, 0, 0, 0.4)");
    await btn.hover();
    await expect(btn).toHaveCSS("background-color", "rgb(0, 0, 0)");
  });

  test("testimonios en video: miniaturas en carrusel y el reproductor se carga al pulsar", async ({ page }) => {
    await open(page);
    const trust = page.getByRole("region", { name: "Más de 6000 profesionales han confiado en CEIUM" });
    await expect(trust.getByRole("link", { name: "Empieza ya" })).toHaveAttribute("href", "/pages/cursos");
    const videos = trust.getByRole("region", { name: "Testimonios en video" });
    const posters = videos.getByRole("button", { name: /^Reproducir video: / });
    await expect(posters).toHaveCount(6);
    await expect(videos.locator("iframe")).toHaveCount(0); // nada de YouTube hasta que se pide
    const firstVideo = videos.locator(".home-video").first();
    await firstVideo.scrollIntoViewIfNeeded();
    expect(await box(firstVideo)).toMatchObject(isMobile(page) ? { x: 15, w: 221, h: 165 } : { x: 525, w: 380, h: 285 });
    await expect(posters.first().locator("img")).toHaveAttribute("src", "https://i.ytimg.com/vi/HdfLwA6L1Xs/hqdefault.jpg");

    await posters.first().click();
    const frame = videos.locator("iframe").first();
    await expect(frame).toHaveAttribute("src", /^https:\/\/www\.youtube-nocookie\.com\/embed\/HdfLwA6L1Xs\?autoplay=1/);
    await expect(frame).toHaveAttribute("title", "CEIUM: 24 años de docencia universitaria");

    // El carrusel de videos también avanza.
    const track = videos.locator(".home-carousel__track");
    await videos.getByRole("button", { name: "Siguiente" }).click();
    await expect.poll(() => scrollLeft(track)).toBe(isMobile(page) ? 233 : 400);
  });

  test("galería y llamada final", async ({ page }) => {
    await open(page);
    const gallery = page.getByRole("region", { name: "Viviendo la experiencia CEIUM", exact: true }).last();
    const items = gallery.locator(".home-gallery__item");
    await expect(items).toHaveCount(11);
    await items.first().scrollIntoViewIfNeeded();
    expect(await box(items.first())).toMatchObject(isMobile(page) ? { x: 21, w: 138, h: 138 } : { x: 143, w: 250, h: 250 });
    const track = gallery.locator(".home-carousel__track");
    await gallery.getByRole("button", { name: "Siguiente" }).click();
    await expect.poll(() => scrollLeft(track)).toBe(isMobile(page) ? 150 : 532);

    const closing = page.getByRole("region", { name: /Capacitación en\s+ultrasonido a tu alcance/ });
    const cta = closing.getByRole("link", { name: "Inscríbete ya" });
    // 135 px con «Inscríbete»; la tienda original mide 127 con la errata «Incríbete».
    expect(await box(cta)).toMatchObject({ w: 135, h: 52 });
  });
});
