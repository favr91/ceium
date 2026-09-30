// Barra de cupo: confirmados (teal) | reservados (ámbar rayado) | libres (gris). Proporcional al cupo.
import "./cohorts.css";
import type { Seats } from "./types";

export function SeatBar({ seats, size }: { seats: Pick<Seats, "capacity" | "confirmed" | "held" | "free">; size?: "lg" }) {
  const { capacity, confirmed, held, free } = seats;
  const label = capacity === 0 ? "Sin cupo" : `${confirmed} ${confirmed === 1 ? "confirmado" : "confirmados"}, ${held} ${held === 1 ? "reservado" : "reservados"}, ${free} ${free === 1 ? "libre" : "libres"} de ${capacity}`;
  if (capacity === 0) return <div className={`seat-bar zero${size ? ` ${size}` : ""}`} role="img" aria-label={label} />;
  const pct = (n: number) => `${(n / capacity) * 100}%`;
  return (
    <div className={`seat-bar${size ? ` ${size}` : ""}`} role="img" aria-label={label} data-confirmed={confirmed} data-held={held} data-free={free}>
      {confirmed > 0 ? <i className="c" style={{ width: pct(confirmed) }} /> : null}
      {held > 0 ? <i className="h" style={{ width: pct(held) }} /> : null}
      {free > 0 ? <i className="f" /> : null}
    </div>
  );
}

export function occupancyPct(s: Pick<Seats, "capacity" | "confirmed" | "held">): number {
  return s.capacity > 0 ? Math.round(((s.confirmed + s.held) / s.capacity) * 100) : 0;
}
