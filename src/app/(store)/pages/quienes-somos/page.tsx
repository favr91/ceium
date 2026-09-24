// /pages/quienes-somos: réplica de la página PageFly de ceium.net (antetítulo + título, banner con video,
// «Sobre CEIUM» y el personal). Contenido editorial en la Setting `store.pages` (ver pages-data).
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { sizedImage } from "@/components/store/home/home-data";
import { getAboutPage } from "@/components/store/pages/pages-data";
import { VideoModal } from "@/components/store/pages/VideoModal";
import "../pages.css";

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const page = await getAboutPage();
  return { title: page.title, description: page.about.text };
}

export default async function AboutPageRoute() {
  await connection();
  const page = await getAboutPage();
  return (
    <div className="pg-pf pg-about">
      <section className="pg-about__intro" aria-labelledby="pg-about-title">
        <div className="pg-container">
          <p className="pg-eyebrow">{page.eyebrow}</p>
          <h1 id="pg-about-title" className="pg-about__title">
            {page.heading}
          </h1>
        </div>
      </section>

      <section className="pg-about__hero" style={{ backgroundImage: `url("${sizedImage(page.hero.image, 2048)}")` }} aria-label={page.hero.videoTitle}>
        <VideoModal youtubeId={page.hero.youtubeId} title={page.hero.videoTitle} playIcon={page.hero.playIcon} />
      </section>

      <section className="pg-about__story" aria-labelledby="pg-about-story">
        <div className="pg-container">
          <div className="pg-about__box">
            <div className="pg-about__copy">
              <h2 id="pg-about-story" className="pg-h2">
                {page.about.title}
              </h2>
              <p className="pg-about__text">{page.about.text}</p>
              <Link href={page.about.cta.url} className="pg-btn">
                {page.about.cta.label}
              </Link>
            </div>
            <div className="pg-about__media">
              {/* eslint-disable-next-line @next/next/no-img-element -- imagen del CDN de Shopify */}
              <img src={sizedImage(page.about.image, 1024)} alt={page.about.imageAlt} width={726} height={524} loading="lazy" />
            </div>
          </div>
        </div>
      </section>

      <section className="pg-team" aria-labelledby="pg-team-title">
        <div className="pg-container">
          <div className="pg-team__head">
            <h2 id="pg-team-title" className="pg-h2 pg-team__title">
              {page.team.title}
            </h2>
            <p className="pg-team__text">{page.team.text}</p>
          </div>
          <ul className="pg-team__grid list-unstyled" role="list">
            {page.team.members.map((m) => (
              <li key={m.name} className="pg-member">
                {/* eslint-disable-next-line @next/next/no-img-element -- fotos del CDN de Shopify */}
                <img className="pg-member__photo" src={sizedImage(m.photo, 550)} alt={m.name} width={316} height={316} loading="lazy" />
                <h3 className="pg-member__name">{m.name}</h3>
                <p className="pg-member__role">{m.role}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
