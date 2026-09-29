"use client";
// Botón y diálogo «Exportar» (réplica del de Shopify): qué exportar (todo, lo que coincide con los filtros, la
// selección o la página actual) y en qué formato (CSV para Excel o CSV sin formato; se recuerda el último usado).
// Descarga <endpoint>?<consulta>&format=… (rutas /admin/<sección>/export, ver app/admin/_lib/export.ts).
import { useState } from "react";
import type { ExportOption } from "./export-options";
import { Modal } from "./ui";

const FORMAT_KEY = "ceium.admin.exportFormat";
const FORMATS = [
  { key: "excel", label: "CSV para Excel, Numbers u otras hojas de cálculo", help: "Columnas con punto y coma, decimales con coma y fechas de Venezuela: se abre con doble clic." },
  { key: "plain", label: "CSV sin formato", help: "Separado por comas, con punto decimal y fechas ISO: para Google Sheets u otros sistemas. Úsalo también si Excel te muestra todo en una sola columna." },
] as const;
type Format = (typeof FORMATS)[number]["key"];

function savedFormat(): Format {
  try {
    return window.localStorage.getItem(FORMAT_KEY) === "plain" ? "plain" : "excel";
  } catch {
    return "excel";
  }
}

export function ExportButton({
  title,
  endpoint,
  options,
  initial,
  className = "btn btn-gray",
  children = "Exportar",
  note,
}: {
  /** Título del diálogo, p. ej. «Exportar pedidos». */
  title: string;
  endpoint: string;
  options: ExportOption[];
  /** Alcance preseleccionado (por defecto el primero). */
  initial?: string;
  className?: string;
  children?: React.ReactNode;
  note?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState(initial ?? options[0]?.key ?? "");
  const [format, setFormat] = useState<Format>("excel");

  const show = () => {
    setScope(initial && options.some((o) => o.key === initial) ? initial : options[0]?.key ?? "");
    setFormat(savedFormat());
    setOpen(true);
  };
  const run = () => {
    const o = options.find((x) => x.key === scope) ?? options[0];
    try {
      window.localStorage.setItem(FORMAT_KEY, format);
    } catch {
      /* sin almacenamiento: no se recuerda el formato */
    }
    const qs = [o?.query, `format=${format}`].filter(Boolean).join("&");
    // Descarga con un enlace temporal (la ruta responde con un adjunto; la página no navega).
    const a = document.createElement("a");
    a.href = `${endpoint}?${qs}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setOpen(false);
  };

  return (
    <>
      <button type="button" className={className} onClick={show}>
        {children}
      </button>
      {open ? (
        <Modal
          title={title}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setOpen(false)}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={run}>Exportar</button>
            </>
          }
        >
          {options.length > 1 ? (
            <div className="xp-group" role="radiogroup" aria-labelledby="xp-scope">
              <div className="xp-h" id="xp-scope">Exportar</div>
              {options.map((o) => (
                <label key={o.key} className="xp-radio">
                  <input type="radio" name="xp-scope" value={o.key} checked={scope === o.key} onChange={() => setScope(o.key)} />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
          ) : null}
          <div className="xp-group" role="radiogroup" aria-labelledby="xp-format">
            <div className="xp-h" id="xp-format">Exportar como</div>
            {FORMATS.map((f) => (
              <label key={f.key} className="xp-radio">
                <input type="radio" name="xp-format" value={f.key} checked={format === f.key} onChange={() => setFormat(f.key)} />
                <span>
                  {f.label}
                  <span className="help">{f.help}</span>
                </span>
              </label>
            ))}
          </div>
          {note ? <p className="help" style={{ marginTop: 12 }}>{note}</p> : null}
        </Modal>
      ) : null}
    </>
  );
}
