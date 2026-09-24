"use client";
// Modal de búsqueda del header con resultados predictivos (colecciones + productos), como el de ceium.net.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { IconArrow, IconClose, IconReset, IconSearch } from "./icons";

interface Suggest {
  q: string;
  collections: { title: string; href: string }[];
  products: { title: string; href: string; image: { url: string; alt: string; width: number | null; height: number | null } | null; price: string | null }[];
}

export function SearchField({ id, defaultValue = "", autoFocus, onValue, inputRef, children, onKeyDown, comboboxProps }: {
  id: string;
  defaultValue?: string;
  autoFocus?: boolean;
  onValue?: (v: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  children?: React.ReactNode;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  comboboxProps?: React.InputHTMLAttributes<HTMLInputElement>;
}) {
  const [value, setValue] = useState(defaultValue);
  const localRef = useRef<HTMLInputElement | null>(null);
  const ref = inputRef ?? localRef;
  return (
    <div className="field search-field">
      <input
        ref={ref}
        className="search__input field__input"
        id={id}
        type="search"
        name="q"
        value={value}
        placeholder="Búsqueda"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus={autoFocus}
        onChange={(e) => {
          setValue(e.target.value);
          onValue?.(e.target.value);
        }}
        onKeyDown={onKeyDown}
        {...comboboxProps}
      />
      <label className="field__label" htmlFor={id}>
        Búsqueda
      </label>
      {value ? (
        <button
          type="button"
          className="reset__button field__button"
          aria-label="Borrar término de búsqueda"
          onClick={() => {
            setValue("");
            onValue?.("");
            ref.current?.focus();
          }}
        >
          <span className="svg-wrapper">
            <IconReset />
          </span>
        </button>
      ) : null}
      <button type="submit" className="search__button field__button" aria-label="Búsqueda">
        <span className="svg-wrapper">
          <IconSearch />
        </span>
      </button>
      {children}
    </div>
  );
}

export function PredictiveSearch({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const inputId = useId();
  const listId = useId();
  const [q, setQ] = useState("");
  const [data, setData] = useState<Suggest | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onValue = (v: string) => {
    setQ(v);
    setSelected(-1);
    if (!v.trim()) setData(null);
    setLoading(!!v.trim());
  };

  useEffect(() => {
    const term = q.trim();
    if (!term) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/search/suggest?q=${encodeURIComponent(term)}`, { signal: ctrl.signal });
        if (res.ok) setData((await res.json()) as Suggest);
      } catch {
        /* abortado o sin red: se mantiene el resultado anterior */
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const term = q.trim();
  const options: { href: string }[] = data && term ? [...data.collections, ...data.products, { href: `/search?q=${encodeURIComponent(term)}` }] : [];
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!options.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (s + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => (s <= 0 ? options.length - 1 : s - 1));
    } else if (e.key === "Enter" && selected >= 0) {
      e.preventDefault();
      router.push(options[selected].href);
      onClose();
    }
  };

  let idx = 0;
  const showResults = !!term && !!data && data.q === term;

  return (
    <div className="search-modal" role="dialog" aria-modal="true" aria-label="Búsqueda" ref={rootRef}>
      <div className="search-modal__overlay" onClick={onClose} aria-hidden="true" />
      <div className="search-modal__content">
        <form
          action="/search"
          method="get"
          role="search"
          className="search search-modal__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!term) return inputRef.current?.focus();
            router.push(`/search?q=${encodeURIComponent(term)}`);
            onClose();
          }}
        >
          <SearchField
            id={`Search-In-Modal-${inputId}`}
            inputRef={inputRef}
            onValue={onValue}
            onKeyDown={onKeyDown}
            comboboxProps={{
              role: "combobox",
              "aria-expanded": showResults,
              "aria-controls": listId,
              "aria-autocomplete": "list",
              "aria-activedescendant": selected >= 0 ? optionId(selected) : undefined,
            }}
          />
          {showResults && data ? (
            <div className="predictive-search" id={listId} role="listbox" aria-label="Resultados de búsqueda" aria-busy={loading}>
              {data.collections.length || data.products.length ? (
                <div className="predictive-search__results-groups-wrapper">
                  {data.collections.length ? (
                    <div className="predictive-search__result-group">
                      <h2 className="predictive-search__heading">Sugerencias</h2>
                      <ul className="predictive-search__results-list list-unstyled" role="group" aria-label="Sugerencias">
                        {data.collections.map((c) => {
                          const i = idx++;
                          return (
                            <li key={c.href} id={optionId(i)} role="option" aria-selected={selected === i} className="predictive-search__list-item">
                              <Link href={c.href} className="predictive-search__item link link--text" tabIndex={-1} onClick={onClose}>
                                <span className="predictive-search__item-heading">{c.title}</span>
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                  {data.products.length ? (
                    <div className="predictive-search__result-group predictive-search__result-group--products">
                      <h2 className="predictive-search__heading">Productos</h2>
                      <ul className="predictive-search__results-list list-unstyled" role="group" aria-label="Productos">
                        {data.products.map((p) => {
                          const i = idx++;
                          return (
                            <li key={p.href} id={optionId(i)} role="option" aria-selected={selected === i} className="predictive-search__list-item">
                              <Link href={p.href} className="predictive-search__item predictive-search__item--link-with-thumbnail link link--text" tabIndex={-1} onClick={onClose}>
                                {p.image ? (
                                  // eslint-disable-next-line @next/next/no-img-element -- miniatura del CDN
                                  <img className="predictive-search__image" src={p.image.url} alt={p.image.alt} width={50} height={p.image.width && p.image.height ? Math.round((50 * p.image.height) / p.image.width) : 50} loading="eager" />
                                ) : null}
                                <span className="predictive-search__item-content">
                                  <span className="predictive-search__item-heading">{p.title}</span>
                                </span>
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div
                id={optionId(idx)}
                role="option"
                aria-selected={selected === idx}
                className={`predictive-search__search-for${data.collections.length || data.products.length ? "" : " predictive-search__search-for--alone"}`}
              >
                <button type="submit" className="predictive-search__item predictive-search__item--term link link--text" tabIndex={-1}>
                  <span>Buscar “{term}”</span>
                  <span className="svg-wrapper">
                    <IconArrow />
                  </span>
                </button>
              </div>
            </div>
          ) : null}
        </form>
        <button type="button" className="search-modal__close-button modal__close-button link link--text" aria-label="Cerrar" onClick={onClose}>
          <span className="svg-wrapper">
            <IconClose />
          </span>
        </button>
      </div>
    </div>
  );
}
