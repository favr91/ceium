import { expect, test, type Page } from "@playwright/test";

// t1 — barra de anuncio, header (menú Educación 2026, cajón móvil, búsqueda, carrito), pie y WhatsApp.
// El menú y el pie salen de la BD (catálogo real sembrado desde ref/products.json, Setting store.contact, sedes).

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1440) < 990;

/** Navega y espera a que el header esté hidratado y la fuente cargada (evita clics durante un cambio de layout). */
async function open(page: Page, url: string) {
  await page.goto(url);
  await page.locator(".section-header[data-ready]").waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

test.describe("t1 cromo de la tienda", () => {
  test("barra de anuncio, logo e iconos del header", async ({ page }) => {
    await open(page, "/");
    await expect(page.getByRole("region", { name: "Anuncio" })).toHaveText("¡Todos nuestros cursos y diplomados están avalados por la UCLA!");
    const header = page.locator(".header");
    await expect(header.getByRole("link").filter({ has: page.getByAltText("CEIUM") })).toHaveAttribute("href", "/");
    await expect(header.getByRole("button", { name: "Búsqueda" })).toBeVisible();
    await expect(header.getByRole("link", { name: /^Carrito/ })).toHaveAttribute("href", "/cart");
    if (isMobile(page)) {
      await expect(header.getByRole("button", { name: "Menú" })).toBeVisible();
      await expect(header.getByRole("link", { name: "Iniciar sesión" })).toBeHidden();
    } else {
      await expect(header.getByRole("link", { name: "Iniciar sesión" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Menú principal" })).toBeVisible();
    }
  });

  test("menú Educación 2026 de escritorio: desplegable con colecciones y productos de la BD", async ({ page }) => {
    test.skip(isMobile(page), "solo escritorio");
    await open(page, "/");
    const nav = page.getByRole("navigation", { name: "Menú principal" });
    // Inicio activo en la home.
    await expect(nav.getByRole("link", { name: "Inicio" })).toHaveAttribute("aria-current", "page");
    for (const name of ["Quiénes Somos", "Preguntas Frecuentes", "Contacto"]) await expect(nav.getByRole("link", { name })).toBeVisible();
    await expect(nav.getByRole("link", { name: "🎓 Campus" })).toHaveAttribute("href", /\/login\/index\.php$/);

    const edu = nav.locator("summary", { hasText: "Educación 2026" });
    await expect(edu).toHaveAttribute("aria-expanded", "false");
    const dropdown = nav.locator(".list-menu--disclosure");
    await expect(dropdown).toBeHidden();
    await edu.click();
    await expect(edu).toHaveAttribute("aria-expanded", "true");
    await expect(dropdown).toBeVisible();
    await dropdown.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished))); // animación de apertura

    // Diplomados (colección «diplomados») como enlaces directos; el resto como submenús.
    await expect(dropdown.getByRole("link", { name: "Diplomado Universitario de Ecografía Integral en el Diagnóstico Médico" })).toHaveAttribute(
      "href",
      "/products/diplomado-universitario-de-ecografia-integral-en-el-diagnostico-medico",
    );
    await expect(dropdown.getByRole("link", { name: "Diplomado Universitario Avanzado de Medicina Materno Fetal" })).toBeVisible();
    const subs = dropdown.locator(":scope > li > details > summary");
    await expect(subs).toHaveText(["🥇 Cursos y talleres que inician de Marzo a Junio", "Cursos Universitarios Fundamentales", "Cursos Avanzados"]);

    // Submenú anidado: acordeón con los productos de la colección, en su orden.
    const avanzados = dropdown.locator("summary", { hasText: "Cursos Avanzados" });
    const avanzadosList = page.locator(`[id="${await avanzados.getAttribute("aria-controls")}"]`);
    await expect(avanzadosList).toBeHidden();
    await avanzados.click();
    await expect(avanzados).toHaveAttribute("aria-expanded", "true");
    await expect(avanzadosList.getByRole("link")).toHaveText([
      "Curso de Ecografía Pulmonar, Vías Respiratorias y Diafragma",
      "Curso de Doppler Abdomen y Renal",
      "Curso Avanzado de Ecografía Mamaria Guiada por Mamografía",
      "Curso Avanzado de Intervencionismo Mamario Guiado por Ecografía",
    ]);

    // Escape cierra y devuelve el foco; clic fuera también cierra.
    await page.keyboard.press("Escape");
    await expect(dropdown).toBeHidden();
    await expect(edu).toBeFocused();
    await edu.click();
    await expect(dropdown).toBeVisible();
    await page.mouse.click(1000, 600);
    await expect(dropdown).toBeHidden();

    // Navegar desde el menú.
    await edu.click();
    await dropdown.getByRole("link", { name: "Diplomado Universitario Avanzado de Medicina Materno Fetal" }).click();
    await expect(page).toHaveURL(/\/products\/diplomado-universitario-avanzado-de-medicina-materno-fetal$/);
    await expect(dropdown).toBeHidden();
  });

  test("cajón de menú móvil con submenús deslizantes", async ({ page }) => {
    test.skip(!isMobile(page), "solo móvil");
    await open(page, "/");
    const toggle = page.locator(".header__icon--menu");
    const drawer = page.locator("#menu-drawer");
    await expect(drawer).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(drawer).toBeVisible();
    await expect(page.locator("body")).toHaveClass(/overflow-hidden-tablet/);

    const top = drawer.locator(".menu-drawer__navigation > .menu-drawer__menu > li > :first-child");
    await expect(top).toHaveText(["Inicio", "Educación 2026", "Quiénes Somos", "Preguntas Frecuentes", "Contacto", "🎓 Campus"]);
    await expect(drawer.getByRole("link", { name: "Inicio" })).toHaveClass(/menu-drawer__menu-item--active/);
    await expect(drawer.getByRole("link", { name: "Iniciar sesión" })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Instagram" })).toHaveAttribute("href", /instagram\.com/);

    // Nivel 1: Educación 2026.
    await drawer.getByRole("button", { name: "Educación 2026" }).click();
    const back1 = drawer.locator('[data-back-for] >> text="Educación 2026"');
    await expect(back1).toBeVisible();
    await expect(back1).toBeFocused();
    const lvl1 = drawer.locator(".menu-drawer__submenu.is-open").first();
    await expect(lvl1.getByRole("link", { name: "Diplomado Universitario Avanzado de Medicina Materno Fetal" })).toBeVisible();

    // Nivel 2: una colección con sus productos.
    await lvl1.getByRole("button", { name: "Cursos Universitarios Fundamentales" }).click();
    const lvl2 = lvl1.locator(".menu-drawer__submenu.is-open");
    await expect(lvl2.getByRole("button", { name: "Cursos Universitarios Fundamentales" })).toBeFocused();
    await expect(lvl2.getByRole("link", { name: "Curso Universitario: Ecografía Obstétrica" })).toBeVisible();

    // Volver dos niveles.
    await lvl2.getByRole("button", { name: "Cursos Universitarios Fundamentales" }).click();
    await expect(lvl2).toBeHidden();
    await back1.click();
    await expect(lvl1).toBeHidden();
    await expect(drawer.getByRole("button", { name: "Educación 2026" })).toBeVisible();

    // Navegar cierra el cajón.
    await open(page, "/search?q=taller");
    await toggle.click();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Inicio" })).not.toHaveClass(/menu-drawer__menu-item--active/);
    await drawer.getByRole("link", { name: "Inicio" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(drawer).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("body")).not.toHaveClass(/overflow-hidden-tablet/);

    // Escape cierra.
    await toggle.click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });

  test("búsqueda predictiva y página de resultados", async ({ page }) => {
    await open(page, "/");
    await page.locator(".header__icon--search").click();
    const dialog = page.getByRole("dialog", { name: "Búsqueda" });
    const input = dialog.getByRole("combobox");
    await expect(input).toBeFocused();
    await input.fill("mamografia"); // sin tilde: la búsqueda ignora acentos y mayúsculas
    const results = dialog.getByRole("listbox");
    await expect(results.getByRole("option", { name: "Curso Avanzado de Ecografía Mamaria Guiada por Mamografía" })).toBeVisible();
    await expect(results.getByRole("option", { name: "Buscar “mamografia”" })).toBeVisible();

    // Teclado: flecha abajo selecciona la primera sugerencia; Enter navega.
    await input.press("ArrowDown");
    await expect(results.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await input.press("Enter");
    await expect(page).toHaveURL(/\/products\/curso-avanzado-de-ecografia-mamaria-guiada-por-mamografia$/);
    await expect(dialog).toBeHidden();

    // Enviar el formulario lleva a /search con los resultados de la BD.
    await open(page, "/");
    await page.locator(".header__icon--search").click();
    await dialog.getByRole("combobox").fill("Ecografía Obstétrica");
    await dialog.getByRole("combobox").press("Enter");
    await expect(page).toHaveURL(/\/search\?q=Ecograf%C3%ADa\+Obst%C3%A9trica|\/search\?q=Ecograf%C3%ADa%20Obst%C3%A9trica/);
    await expect(page.getByRole("heading", { name: "Resultados de búsqueda", level: 1 })).toBeVisible();
    await expect(page.getByRole("status")).toContainText('para "Ecografía Obstétrica"');
    await expect(page.getByRole("heading", { name: "Curso Universitario: Ecografía Obstétrica", level: 3 })).toBeVisible();
    await expect(page.locator(".card__price").first()).toHaveText(/^A partir de \$[\d,]+\.\d{2} USD$/);

    // Escape cierra el modal.
    await page.locator(".header__icon--search").click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("burbuja del carrito sigue la cookie del carrito", async ({ page }) => {
    await open(page, "/");
    const cart = page.locator(".header__icon--cart");
    await expect(cart).toHaveAttribute("aria-label", "Carrito");
    await open(page, "/cart/add?product=curso-universitario-ecografia-obstetrica&modality=ONLINE&plan=FULL");
    await expect(cart).toHaveAttribute("aria-label", "Carrito, 1 artículo");
    await expect(cart.locator(".cart-count-bubble")).toHaveText("1");
  });

  test("pie con redes, teléfonos y sedes de la BD, y botón de WhatsApp", async ({ page }) => {
    await open(page, "/");
    const footer = page.locator("footer.footer");
    await expect(footer.getByRole("link", { name: "Facebook" })).toHaveAttribute("href", "https://www.facebook.com/ceium/");
    await expect(footer.getByRole("link", { name: "Instagram" })).toHaveAttribute("href", "https://instagram.com/ceiumoficial");
    await expect(footer.getByRole("link", { name: "YouTube" })).toHaveAttribute("href", "https://www.youtube.com/@ceium2447");
    await expect(footer.getByRole("heading", { name: "Teléfonos" })).toBeVisible();
    await expect(footer.getByRole("link", { name: "+58 412-0840407" })).toHaveAttribute("href", "tel:+584120840407");
    await expect(footer.getByRole("link", { name: "+58 412-5250748" })).toHaveAttribute("href", "tel:+584125250748");
    await expect(footer.getByRole("heading", { name: "Sedes CEIUM" })).toBeVisible();
    await expect(footer.locator(".footer-block--menu").last().locator("li")).toHaveCount(3);
    await expect(footer).toContainText("Barquisimeto: Av. Andrés Bello entre carreras 33 y 34");
    await expect(footer).toContainText("Maracaibo: Av. Universidad entre Av. 10 y 12, Urb. La Estrella Unimedica.");
    await expect(footer).toContainText(`© ${new Date().getFullYear()}, CEIUM`);
    await footer.getByRole("link", { name: "Política de privacidad" }).click();
    await expect(page.getByRole("heading", { name: "Política de privacidad", level: 1 })).toBeVisible();

    const wa = page.getByRole("link", { name: "Escríbenos por WhatsApp" });
    await expect(wa).toBeVisible();
    const href = await wa.getAttribute("href");
    expect(href).toMatch(/^https:\/\/wa\.me\/\+584120840718\?text=/);
    expect(decodeURIComponent(href!.split("text=")[1])).toBe("Hola, quiero conocer sobre los cursos y diplomados que ofrece CEIUM.");
    await expect(wa).toHaveAttribute("target", "_blank");
  });

  test("header sticky: se oculta al bajar y reaparece al subir", async ({ page }) => {
    await open(page, "/search?q=curso");
    const section = page.locator(".section-header");
    const top = () => section.evaluate((el) => Math.round(el.getBoundingClientRect().top));
    const scrollTo = (y: number) => page.evaluate((y) => window.scrollTo(0, y), y);
    await expect.poll(top).toBeGreaterThan(30); // bajo la barra de anuncio
    await scrollTo(600);
    await scrollTo(1200);
    await expect.poll(top).toBeLessThan(-40); // al bajar se oculta
    await scrollTo(900);
    await expect.poll(top).toBe(0); // al subir reaparece pegado arriba
    await scrollTo(0);
    await expect.poll(top).toBeGreaterThan(30);
  });
});
