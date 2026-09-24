"use client";
// Pestañas de /pages/cursos (réplica del Tabs de PageFly en ceium.net): una pestaña por colección con su rejilla
// de tarjetas «Inscríbete». Todas las pestañas se renderizan en el servidor (las inactivas con `hidden`); el
// cliente solo cambia cuál se ve. Accesible (tablist/tab/tabpanel, flechas ←/→, Inicio/Fin) y enlazable:
// /pages/cursos#cursos-avanzados abre esa pestaña y el hash se actualiza al cambiar.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CollectionNote } from "@/components/store/collection/collection-data";

export interface CourseCard {
  slug: string;
  title: string;
  href: string;
  image: { url: string; width: number | null; height: number | null } | null;
  note: CollectionNote | null;
  open: boolean;
}

export interface CourseTabData {
  id: string;
  label: string;
  /** "status": nota de estado de inscripción, oculta en móvil (como en ceium.net). */
  note: "product" | "status";
  products: CourseCard[];
}

function Note({ note, statusOnly }: { note: CollectionNote | null; statusOnly: boolean }) {
  if (!note) return null;
  const cls = `pg-card__note${statusOnly ? " pg-card__note--status" : ""}${note.kind === "closed" ? " pg-card__note--closed" : ""}`;
  if (note.kind === "deadline") {
    return (
      <p className={cls}>
        {note.label} <time dateTime={note.iso}>{note.date}</time>
      </p>
    );
  }
  return <p className={cls}>{note.text}</p>;
}

export function CourseTabs({ tabs }: { tabs: CourseTabData[] }) {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const select = useCallback(
    (i: number, opts: { focus?: boolean; hash?: boolean } = {}) => {
      setActive(i);
      const btn = tabRefs.current[i];
      if (btn) {
        if (opts.focus) btn.focus();
        // En móvil la barra se desplaza para que la pestaña elegida quede a la vista.
        const bar = btn.parentElement;
        if (bar && bar.scrollWidth > bar.clientWidth) {
          const left = btn.offsetLeft - bar.offsetLeft;
          const target = left + btn.offsetWidth > bar.scrollLeft + bar.clientWidth ? left + btn.offsetWidth - bar.clientWidth : left < bar.scrollLeft ? left : bar.scrollLeft;
          bar.scrollTo({ left: target, behavior: "smooth" });
        }
      }
      if (opts.hash !== false) {
        const url = `${window.location.pathname}${window.location.search}${i === 0 ? "" : `#${tabs[i].id}`}`;
        window.history.replaceState(window.history.state, "", url);
      }
    },
    [tabs],
  );

  useEffect(() => {
    const fromHash = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const i = tabs.findIndex((t) => t.id === id);
      if (i >= 0) select(i, { hash: false });
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [tabs, select]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = tabs.length - 1;
    const next = e.key === "ArrowRight" ? (active === last ? 0 : active + 1) : e.key === "ArrowLeft" ? (active === 0 ? last : active - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    select(next, { focus: true });
  };

  return (
    <div className="pg-tabs" data-active-tab={tabs[active]?.id}>
      <div className="pg-tabs__bar" role="tablist" aria-label="Tipos de curso" onKeyDown={onKeyDown}>
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`pg-tab-${t.id}`}
            aria-controls={`pg-panel-${t.id}`}
            aria-selected={i === active}
            tabIndex={i === active ? 0 : -1}
            className="pg-tabs__tab"
            onClick={() => select(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t, i) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`pg-panel-${t.id}`}
          aria-labelledby={`pg-tab-${t.id}`}
          hidden={i !== active}
          className={`pg-tabs__panel${i === 0 ? " pg-tabs__panel--first" : ""}`}
          data-collection={t.id}
        >
          <ul className="pg-cards list-unstyled" role="list">
            {t.products.map((p) => (
              <li key={p.slug} className="pg-card coll-hover" data-product={p.slug}>
                <Link href={p.href} className="pg-card__media" tabIndex={-1} aria-hidden="true">
                  {p.image ? (
                    // eslint-disable-next-line @next/next/no-img-element -- imágenes del CDN de Shopify / uploads
                    <img src={p.image.url} alt="" width={p.image.width ?? 16} height={p.image.height ?? 9} loading={i === 0 ? "eager" : "lazy"} />
                  ) : null}
                </Link>
                <h3 className="pg-card__title">
                  <Link href={p.href}>{p.title}</Link>
                </h3>
                <Note note={p.note} statusOnly={t.note === "status"} />
                <Link href={p.href} className="pg-card__btn" aria-label={`${p.open ? "Inscríbete" : "Ver programa"}: ${p.title}`}>
                  {p.open ? "Inscríbete" : "Ver programa"}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
