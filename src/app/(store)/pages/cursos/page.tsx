// /pages/cursos: réplica de «Nuestros cursos» de ceium.net (pestañas PageFly con la rejilla de tarjetas
// «Inscríbete»). Cada pestaña es una colección de la BD: programas publicados, orden, imágenes y notas de
// inscripción salen del catálogo; las pestañas (etiqueta → colección) se configuran en la Setting `store.pages`.
import type { Metadata } from "next";
import { connection } from "next/server";
import { sizedImage } from "@/components/store/home/home-data";
import { CourseTabs, type CourseTabData } from "@/components/store/pages/CourseTabs";
import { getCoursesPage, NOTE_STATUS_OPEN } from "@/components/store/pages/pages-data";
import "../../collections/[slug]/collection.css";
import "../pages.css";

export const metadata: Metadata = { title: "Nuestros cursos" };

export default async function CoursesPageRoute() {
  await connection(); // catálogo y estado de inscripción en vivo
  const page = await getCoursesPage();
  const tabs: CourseTabData[] = page.tabs.map((t) => ({
    id: t.id,
    label: t.label,
    note: t.note,
    products: t.products.map((p) => ({
      slug: p.slug,
      title: p.title,
      href: p.href,
      image: p.image ? { url: sizedImage(p.image.url, 560), width: p.image.width, height: p.image.height } : null,
      // Pestañas de «estado»: solo si las inscripciones están abiertas o cerradas (texto de ceium.net).
      note: t.note === "status" ? (p.open ? { kind: "text", text: NOTE_STATUS_OPEN } : p.note) : p.note,
      open: p.open,
    })),
  }));
  return (
    <div className="pg-pf pg-courses">
      <section className="pg-courses__section" aria-labelledby="pg-courses-title">
        <div className="pg-container">
          <h1 id="pg-courses-title" className="pg-courses__title">
            {page.title}
          </h1>
          {tabs.length ? <CourseTabs tabs={tabs} /> : <p className="pg-empty">Pronto publicaremos nuevos programas.</p>}
        </div>
      </section>
    </div>
  );
}
