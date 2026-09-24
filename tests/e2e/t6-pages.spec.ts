import Database from "better-sqlite3";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { e2eEnv } from "../../playwright.config";
import { one, q } from "./support/purchase";

// t6 — páginas informativas: Quiénes somos (video en diálogo, equipo), Preguntas frecuentes (acordeón de una sola
// respuesta abierta), Contacto (datos de la BD + formulario que llega al buzón de CEIUM) y Nuestros cursos
// (pestañas por colección de la BD). Geometría medida en ceium.net en vivo (1440 × 900 / 390 × 844).
//   E2E_LANE=tienda E2E_PORT=3101 npx playwright test tests/e2e/t6-pages.spec.ts

const DB_FILE = e2eEnv.DATABASE_URL.replace(/^file:/, "");
const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1440) < 750;
const sqlDate = (d: Date) => d.toISOString().replace("Z", "+00:00");

function exec(sql: string, ...params: unknown[]) {
  const db = new Database(DB_FILE);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

/** Cambia una Setting durante `fn` y la restaura siempre. */
async function withSetting(key: string, value: unknown, fn: () => Promise<void>) {
  const prev = one<{ value: string } | undefined>(`SELECT value FROM Setting WHERE key = ?`, key);
  exec(
    `INSERT INTO Setting (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    JSON.stringify(value),
    sqlDate(new Date()),
  );
  try {
    await fn();
  } finally {
    if (prev) exec(`UPDATE Setting SET value = ? WHERE key = ?`, prev.value, key);
    else exec(`DELETE FROM Setting WHERE key = ?`, key);
  }
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function box(loc: Locator) {
  const b = await loc.boundingBox();
  if (!b) throw new Error("sin caja");
  const scrollY = await loc.page().evaluate(() => window.scrollY);
  return { x: Math.round(b.x), y: Math.round(b.y + scrollY), w: Math.round(b.width), h: Math.round(b.height) };
}

function productsOf(slug: string) {
  return q<{ slug: string; title: string; id: string }>(
    `SELECT p.slug, p.title, p.id FROM CollectionProduct cp JOIN Collection c ON c.id = cp.collectionId JOIN Product p ON p.id = cp.productId
     WHERE c.slug = ? AND p.published = 1 ORDER BY cp.position`,
    slug,
  );
}

test.describe("t6 · Quiénes somos", () => {
  test("título, banner, «Sobre CEIUM» y el personal al píxel", async ({ page }) => {
    await open(page, "/pages/quienes-somos");
    await expect(page).toHaveTitle(/Quiénes Somos/);
    await expect(page.locator(".pg-eyebrow")).toHaveText("Quiénes somos");
    await expect(page.locator(".pg-eyebrow")).toHaveCSS("text-transform", "uppercase");
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText("Centro de Enseñanza e Investigación de Ultrasonido en Medicina");
    await expect(page.getByRole("link", { name: "Contáctanos" })).toHaveAttribute("href", "/pages/contacto");
    const members = page.locator(".pg-member");
    await expect(members).toHaveCount(8);
    await expect(members.first().locator(".pg-member__name")).toHaveText("Dr. Carlos Roa");
    await expect(members.first().locator(".pg-member__role")).toHaveText("Director y Fundador");

    const hero = await box(page.locator(".pg-about__hero"));
    if (isMobile(page)) {
      await expect(h1).toHaveCSS("font-size", "33px");
      expect(hero.h).toBe(200);
      // Dos columnas de 174 px separadas 12 px.
      const [a, b] = [await box(members.nth(0).locator("img")), await box(members.nth(1).locator("img"))];
      expect([a.x, a.w, b.x]).toEqual([15, 174, 201]);
    } else {
      await expect(h1).toHaveCSS("font-size", "57px");
      expect(hero.h).toBe(456);
      const xs = await Promise.all([0, 1, 2, 3].map((i) => box(members.nth(i).locator("img"))));
      for (const [i, b] of xs.entries()) expect(Math.abs(b.x - (217 + i * 258))).toBeLessThanOrEqual(1);
      // La segunda fila empieza 24 px debajo de la fila más alta (roles de dos líneas).
      const row2 = await box(members.nth(4).locator("img"));
      expect(Math.abs(row2.y - xs[0].y - 324)).toBeLessThanOrEqual(1);
      const story = await box(page.locator(".pg-about__box"));
      expect([story.x, story.w]).toEqual([135, 1170]);
    }
  });

  test("el botón play abre el video de YouTube en un diálogo que se cierra con Esc, la X o el fondo", async ({ page }) => {
    await open(page, "/pages/quienes-somos");
    const dialog = page.getByRole("dialog", { name: "Qué es CEIUM" });
    await expect(dialog).toBeHidden();
    await expect(page.locator(".pg-video iframe")).toHaveCount(0);

    await page.getByRole("button", { name: "Ver video: Qué es CEIUM" }).click();
    await expect(dialog).toBeVisible();
    const iframe = dialog.locator("iframe");
    await expect(iframe).toHaveAttribute("src", /^https:\/\/www\.youtube\.com\/embed\/g89TX4MwV8Q\?autoplay=1/);
    const frame = await box(dialog.locator(".pg-video__frame"));
    expect(Math.abs(frame.w / frame.h - 16 / 9)).toBeLessThan(0.02);
    expect(frame.w).toBeLessThanOrEqual(isMobile(page) ? 358 : 854);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator(".pg-video iframe")).toHaveCount(0); // el video se detiene

    await page.getByRole("button", { name: "Ver video: Qué es CEIUM" }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cerrar video" }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: "Ver video: Qué es CEIUM" }).click();
    await expect(dialog).toBeVisible();
    await page.mouse.click(5, 5); // fondo del diálogo
    await expect(dialog).toBeHidden();
  });

  test("el contenido es editable con la Setting store.pages", async ({ page }) => {
    await withSetting(
      "store.pages",
      {
        "quienes-somos": {
          heading: "Formación en ultrasonido desde 2002",
          team: { members: [{ name: "Dra. Prueba T6", role: "Docente invitada", photo: "https://cdn.shopify.com/s/files/1/0653/7986/0524/files/Rectangle_46.jpg" }] },
        },
      },
      async () => {
        await open(page, "/pages/quienes-somos");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Formación en ultrasonido desde 2002");
        await expect(page.locator(".pg-member")).toHaveCount(1);
        await expect(page.locator(".pg-member__name")).toHaveText("Dra. Prueba T6");
        // Lo no sobreescrito conserva el valor por defecto.
        await expect(page.locator(".pg-team__title")).toHaveText("Personal de CEIUM");
      },
    );
  });
});

test.describe("t6 · Preguntas frecuentes", () => {
  test("acordeón: la primera abierta, una sola a la vez, teclado y enlace directo", async ({ page }) => {
    await open(page, "/pages/preguntas-frecuentes");
    const items = page.locator(".pg-faq__item");
    await expect(items).toHaveCount(13);
    const answer = (i: number) => items.nth(i).locator(".pg-faq__a");
    await expect(answer(0)).toBeVisible();
    await expect(answer(0)).toHaveText("No, los diplomados no conducen a especialidad.");
    await expect(answer(1)).toBeHidden();

    await items.nth(2).locator("summary").click();
    await expect(answer(2)).toBeVisible();
    await expect(answer(2)).toContainText("puedes realizar como curso aislado");
    await expect(answer(0)).toBeHidden();
    await expect(items.nth(2).locator(".pg-faq__icon")).toHaveCSS("transform", /matrix\(0, 1, -1, 0/); // flecha hacia abajo

    await items.nth(2).locator("summary").click();
    await expect(answer(2)).toBeHidden();

    await items.nth(1).locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(answer(1)).toBeVisible();
    await expect(answer(1).getByRole("link", { name: "Diplomado Universitario Avanzado en Medicina Materno-Fetal" })).toHaveAttribute(
      "href",
      "/products/diplomado-universitario-avanzado-de-medicina-materno-fetal",
    );

    await open(page, "/pages/preguntas-frecuentes#faq-13");
    await expect(answer(12)).toBeVisible();
    await expect(answer(12)).toContainText("Sede Maracaibo:");
    await expect(answer(0)).toBeHidden();
  });

  test("geometría de las tarjetas y la llamada final", async ({ page }) => {
    await open(page, "/pages/preguntas-frecuentes");
    const q0 = await box(page.locator(".pg-faq__q").first());
    const q1 = await box(page.locator(".pg-faq__q").nth(1));
    const title = page.getByRole("heading", { level: 1, name: "Preguntas Frecuentes" });
    if (isMobile(page)) {
      expect([q0.x, q0.w, q0.h]).toEqual([15, 360, 74]);
      await expect(title).toHaveCSS("font-size", "33px");
    } else {
      expect([q0.x, q0.w, q0.h]).toEqual([274, 892, 70]);
      // Respuesta de una línea: 16 (margen) + 19 + 24 (relleno) → la siguiente pregunta 131 px más abajo.
      expect(q1.y - q0.y).toBe(131);
      await expect(title).toHaveCSS("font-size", "46px");
    }
    const cta = page.locator(".home-closing").getByRole("link", { name: "Contáctanos" });
    await expect(cta).toHaveAttribute("href", "/pages/contacto");
    await expect(page.locator(".home-closing__title")).toHaveText("Capacitación en\nUltrasonido a tu alcance");
  });
});

test.describe("t6 · Contacto", () => {
  test("teléfonos, correos, sedes y redes salen de la BD", async ({ page }) => {
    const contact = one<{ value: string }>(`SELECT value FROM Setting WHERE key = 'store.contact'`);
    const value = JSON.parse(contact.value) as { phones: string[]; emails: string[] };
    await open(page, "/pages/contacto");
    const info = page.locator(".pg-contact__info");
    await expect(info.getByRole("heading", { level: 1 })).toHaveText("Contáctanos");
    for (const p of value.phones) await expect(info.getByRole("link", { name: p })).toHaveAttribute("href", `tel:${p.replace(/[^\d+]/g, "")}`);
    for (const e of value.emails) await expect(info.getByRole("link", { name: e })).toHaveAttribute("href", `mailto:${e}`);
    const sedes = q<{ name: string; address: string }>(`SELECT name, address FROM Sede WHERE active = 1 ORDER BY position`);
    await expect(page.locator(".pg-contact__sede")).toHaveCount(sedes.length);
    for (const [i, s] of sedes.entries()) await expect(page.locator(".pg-contact__sede").nth(i)).toHaveText(`${s.name}: ${s.address}`);
    await expect(page.locator(".pg-contact__social a")).toHaveCount(3);
    await expect(page.locator(".pg-contact__social").getByRole("link", { name: "Instagram" })).toHaveAttribute("href", /instagram\.com\/ceiumoficial/);

    await withSetting("store.contact", { ...value, phones: ["+58 414-0000001"], emails: ["t6@ceium.test"] }, async () => {
      await open(page, "/pages/contacto");
      await expect(page.locator(".pg-contact__list--phones li")).toHaveText(["+58 414-0000001"]);
      await expect(page.locator(".pg-contact__list--emails li")).toHaveText(["t6@ceium.test"]);
    });
  });

  test("geometría de las dos tarjetas y del formulario", async ({ page }) => {
    await open(page, "/pages/contacto");
    const info = await box(page.locator(".pg-contact__info"));
    const form = await box(page.locator(".pg-contact__form"));
    const nombre = await box(page.getByLabel("Nombre"));
    const apellido = await box(page.getByLabel("Apellido"));
    const send = await box(page.getByRole("button", { name: "Enviar mensaje" }));
    expect(nombre.h).toBe(46);
    expect(send.h).toBe(52);
    await expect(page.getByPlaceholder("Ingresa tu nombre")).toHaveCSS("background-color", "rgb(253, 253, 253)");
    if (isMobile(page)) {
      expect([info.x, info.w, form.x, form.w]).toEqual([15, 360, 15, 360]);
      expect(form.y - (info.y + info.h)).toBe(16);
      expect(apellido.y).toBeGreaterThan(nombre.y + nombre.h);
    } else {
      expect([info.x, info.w, form.x, form.w]).toEqual([135, 555, 750, 555]);
      expect(info.h).toBe(form.h);
      expect([nombre.x, nombre.w, apellido.x, apellido.y]).toEqual([783, 237, 1036, nombre.y]);
    }
  });

  test("el formulario envía el mensaje al buzón de CEIUM (validación, trampa y sin duplicados)", async ({ page }, info) => {
    const stamp = `${Date.now()}-${info.project.name}`;
    const email = `medico.${stamp}@example.com`;
    const inbox = (JSON.parse(one<{ value: string }>(`SELECT value FROM Setting WHERE key = 'store.contact'`).value) as { emails: string[] }).emails;
    const rows = () => q<{ to: string; subject: string; html: string; text: string }>(`SELECT "to", subject, html, text FROM EmailOutbox WHERE template = 'contact_message' AND text LIKE ?`, `%${stamp}%`);

    await open(page, "/pages/contacto");
    const form = page.locator(".pg-form");
    // Nombre con solo espacios: pasa `required` del navegador pero el servidor lo rechaza.
    await form.getByLabel("Nombre").fill("   ");
    await form.getByLabel("Correo electrónico").fill(email);
    await form.getByLabel("Mensaje").fill(`Hola, quiero información del diplomado. ${stamp}`);
    await form.getByRole("button", { name: "Enviar mensaje" }).click();
    await expect(form.locator(".pg-form__error")).toHaveText("Ingresa tu nombre.");
    await expect(form.getByLabel("Nombre")).toHaveAttribute("aria-invalid", "true");
    await expect(form.getByLabel("Nombre")).toBeFocused();
    await expect(form.getByLabel("Mensaje")).toHaveValue(`Hola, quiero información del diplomado. ${stamp}`); // no se pierde lo escrito
    expect(rows()).toHaveLength(0);

    await form.getByLabel("Nombre").fill("Ana <b>María</b>");
    await form.getByLabel("Apellido").fill("Pérez");
    await form.getByRole("button", { name: "Enviar mensaje" }).click();
    await expect(form.getByRole("status")).toHaveText(/Gracias por escribirnos/);
    await expect(form.getByLabel("Nombre")).toHaveValue(""); // formulario limpio tras enviar
    await expect.poll(() => rows().length).toBe(1);
    const [mail] = rows();
    expect(mail.to).toBe(inbox.join(", "));
    expect(mail.subject).toBe("Nuevo mensaje de contacto de Ana <b>María</b> Pérez");
    expect(mail.html).toContain("Ana &lt;b&gt;María&lt;/b&gt;"); // el HTML del médico se escapa
    expect(mail.html).toContain(`mailto:${email}`);
    expect(mail.text).toContain(`Hola, quiero información del diplomado. ${stamp}`);

    // El mismo mensaje otra vez (doble clic, recarga): no se duplica en el buzón.
    await form.getByLabel("Nombre").fill("Ana");
    await form.getByLabel("Correo electrónico").fill(email);
    await form.getByLabel("Mensaje").fill(`Hola, quiero información del diplomado. ${stamp}`);
    await form.getByRole("button", { name: "Enviar mensaje" }).click();
    await expect(form.getByRole("status")).toHaveText(/Gracias por escribirnos/);
    expect(rows()).toHaveLength(1);

    // Campo trampa lleno (bot): responde bien pero no envía nada.
    await open(page, "/pages/contacto");
    await page.locator('input[name="website"]').evaluate((el: HTMLInputElement) => (el.value = "spam"));
    await form.getByLabel("Nombre").fill("Bot");
    await form.getByLabel("Correo electrónico").fill(`bot.${stamp}@example.com`);
    await form.getByLabel("Mensaje").fill(`Compra seguidores ${stamp}-bot`);
    await form.getByRole("button", { name: "Enviar mensaje" }).click();
    await expect(form.getByRole("status")).toHaveText(/Gracias por escribirnos/);
    expect(q(`SELECT id FROM EmailOutbox WHERE text LIKE ?`, `%${stamp}-bot%`)).toHaveLength(0);
  });
});

test.describe("t6 · Nuestros cursos", () => {
  const TABS = [
    { label: "Cursos Universitarios Fundamentales", slug: "cursos-universitarios" },
    { label: "Cursos Avanzados", slug: "cursos-avanzados" },
    { label: "Talleres Especializados", slug: "talleres-especializados" },
  ];

  test("una pestaña por colección con sus programas de la BD; clic, teclado y enlace directo", async ({ page }) => {
    await open(page, "/pages/cursos");
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveText(TABS.map((t) => t.label));
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

    const panel = page.getByRole("tabpanel");
    await expect(panel).toHaveCount(1); // las ocultas no están en el árbol accesible
    const firstProducts = productsOf(TABS[0].slug);
    await expect(panel.locator(".pg-card")).toHaveCount(firstProducts.length);
    await expect(panel.locator(".pg-card__title")).toHaveText(firstProducts.map((p) => p.title));

    await page.getByRole("tab", { name: "Cursos Avanzados" }).click();
    await expect(page.getByRole("tab", { name: "Cursos Avanzados" })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/#cursos-avanzados$/);
    const adv = productsOf("cursos-avanzados");
    await expect(page.getByRole("tabpanel").locator(".pg-card__title")).toHaveText(adv.map((p) => p.title));
    await expect(page.getByRole("tabpanel").locator(".pg-card__btn").first()).toHaveAttribute("href", `/products/${adv[0].slug}`);
    // Nota de estado: visible en escritorio, oculta en móvil (como en ceium.net).
    const note = page.getByRole("tabpanel").locator(".pg-card__note").first();
    if (isMobile(page)) await expect(note).toBeHidden();
    else await expect(note).toHaveText("✍ Inscripciones abiertas");

    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Talleres Especializados" })).toBeFocused();
    await expect(page.getByRole("tabpanel").locator(".pg-card")).toHaveCount(productsOf("talleres-especializados").length);
    if (isMobile(page)) {
      // La barra se desplaza para mostrar la pestaña elegida completa.
      const t = await page.getByRole("tab", { name: "Talleres Especializados" }).boundingBox();
      await expect.poll(async () => Math.round(((await page.getByRole("tab", { name: "Talleres Especializados" }).boundingBox())?.x ?? 999) + (t?.width ?? 0))).toBeLessThanOrEqual(376);
    }
    await page.keyboard.press("Home");
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

    await open(page, "/pages/cursos#talleres-especializados");
    await expect(page.getByRole("tab", { name: "Talleres Especializados" })).toHaveAttribute("aria-selected", "true");
  });

  test("un programa despublicado desaparece de su pestaña", async ({ page }) => {
    const [target] = productsOf("cursos-avanzados");
    exec(`UPDATE Product SET published = 0 WHERE id = ?`, target.id);
    try {
      await open(page, "/pages/cursos#cursos-avanzados");
      const panel = page.getByRole("tabpanel");
      await expect(panel.locator(".pg-card")).toHaveCount(productsOf("cursos-avanzados").length);
      await expect(panel.locator(`[data-product="${target.slug}"]`)).toHaveCount(0);
    } finally {
      exec(`UPDATE Product SET published = 1 WHERE id = ?`, target.id);
    }
  });

  test("geometría de pestañas, panel y tarjetas", async ({ page }) => {
    await open(page, "/pages/cursos");
    const tab0 = await box(page.getByRole("tab").first());
    const panel = page.getByRole("tabpanel");
    const p = await box(panel);
    const c0 = await box(panel.locator(".pg-card").nth(0));
    const c1 = await box(panel.locator(".pg-card").nth(1));
    await expect(page.getByRole("tab").first()).toHaveCSS("background-color", "rgb(241, 241, 241)");
    await expect(page.getByRole("tab").nth(1)).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(panel).toHaveCSS("border-top-left-radius", "0px");
    if (isMobile(page)) {
      expect([tab0.x, tab0.h]).toEqual([15, 42]);
      expect([p.x, p.w]).toEqual([15, 360]);
      expect([c0.x, c0.y - p.y, c0.w, c1.x]).toEqual([25, 10, 165, 200]);
      await expect(panel.locator(".pg-card__btn").first()).toHaveCSS("width", "143px");
    } else {
      expect([tab0.x, tab0.w, tab0.h]).toEqual([135, 399, 58]);
      expect([p.x, p.w, p.y]).toEqual([135, 1170, tab0.y + 58]);
      expect([c0.x, c0.y - p.y, c1.x - c0.x]).toEqual([183, 48, 273]);
      const btn = page.getByRole("tabpanel").locator(".pg-card__btn").first();
      await expect(btn).toHaveCSS("font-weight", "600");
      expect((await box(btn)).h).toBe(41);
    }
  });
});
