"use client";
// Acordeón de preguntas frecuentes (réplica del Accordion de PageFly en ceium.net): una sola respuesta abierta a
// la vez, la primera abierta al cargar. Se apoya en <details>/<summary> (funciona sin JS y con teclado); el
// atributo `name` agrupa los <details> y el onToggle asegura la exclusividad en navegadores que no lo soportan.
// Abrir una pregunta desde el enlace #faq-<n> también funciona.
import { useEffect, useRef } from "react";

export interface FaqAccordionItem {
  question: string;
  answerHtml: string;
}

function Caret() {
  return (
    <svg className="pg-faq__icon" aria-hidden="true" focusable="false" viewBox="0 0 256 512" width="8" height="16">
      <path
        fill="currentColor"
        d="M246.6 278.6c12.5-12.5 12.5-32.8 0-45.3l-128-128c-9.2-9.2-22.9-11.9-34.9-6.9s-19.8 16.6-19.8 29.6l0 256c0 12.9 7.8 24.6 19.8 29.6s25.7 2.2 34.9-6.9l128-128z"
      />
    </svg>
  );
}

export function FaqAccordion({ items }: { items: FaqAccordionItem[] }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Enlace directo a una pregunta (#faq-3), al cargar o al cambiar el hash: se abre esa y se cierran las demás.
    const fromHash = () => {
      const id = window.location.hash.slice(1);
      const target = id ? root.current?.querySelector<HTMLDetailsElement>(`details#${CSS.escape(id)}`) : null;
      if (!target) return;
      root.current?.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((d) => {
        if (d !== target) d.open = false;
      });
      target.open = true;
      target.scrollIntoView({ block: "start" });
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  const onToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    const el = e.currentTarget;
    if (!el.open) return;
    root.current?.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((d) => {
      if (d !== el) d.open = false;
    });
  };

  return (
    <div className="pg-faq__list" ref={root}>
      {items.map((item, i) => (
        <details key={i} id={`faq-${i + 1}`} name="faq" className="pg-faq__item" open={i === 0} onToggle={onToggle}>
          <summary className="pg-faq__q">
            <span>{item.question}</span>
            <Caret />
          </summary>
          <div className="pg-faq__a" dangerouslySetInnerHTML={{ __html: item.answerHtml }} />
        </details>
      ))}
    </div>
  );
}
