// /pages/preguntas-frecuentes: réplica de la página PageFly de ceium.net (acordeón de preguntas con una sola
// respuesta abierta y la llamada final «¡Inscripciones abiertas!»). Preguntas y respuestas en la Setting
// `store.pages` (ver pages-data).
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { FaqAccordion } from "@/components/store/pages/FaqAccordion";
import { getFaqPage } from "@/components/store/pages/pages-data";
import "../../home.css";
import "../pages.css";

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const page = await getFaqPage();
  return { title: page.title, description: page.items.slice(0, 3).map((i) => i.question).join(" ") };
}

export default async function FaqPageRoute() {
  await connection();
  const page = await getFaqPage();
  const { closing } = page;
  return (
    <div className="pg-pf pg-faq">
      <section className="pg-faq__section" aria-labelledby="pg-faq-title">
        <div className="pg-container">
          <h1 id="pg-faq-title" className="pg-faq__title">
            {page.title}
          </h1>
          <FaqAccordion items={page.items} />
        </div>
      </section>
      <div className="home">
        <section className="home-closing" aria-labelledby="pg-faq-closing">
          <div className="home-container">
            <div className="home-closing__box" style={{ backgroundImage: `url("${closing.image}")` }}>
              <p className="home-closing__eyebrow">{closing.eyebrow}</p>
              <h2 id="pg-faq-closing" className="home-closing__title">
                {closing.title}
              </h2>
              <p className="home-closing__text">{closing.text}</p>
              <Link href={closing.cta.url} className="home-btn home-btn--lg">
                {closing.cta.label}
              </Link>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
