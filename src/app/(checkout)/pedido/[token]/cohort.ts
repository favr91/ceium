// Datos de la cohorte de un ítem semipresencial para la página del pedido y su calendario (.ics).
export interface CohortSession {
  date: string; // AAAA-MM-DD (hora de Caracas)
  title?: string;
  startTime?: string; // HH:MM
  endTime?: string;
}

export function cohortSessions(raw: unknown): CohortSession[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is CohortSession => !!s && typeof (s as CohortSession).date === "string" && /^\d{4}-\d{2}-\d{2}$/.test((s as CohortSession).date))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Enlace de «Cómo llegar»: el mapa cargado en el panel o una búsqueda de Google Maps con la dirección. */
export function directionsUrl(sede: { name: string; address: string | null; mapUrl?: string | null } | null | undefined): string | null {
  if (!sede) return null;
  if (sede.mapUrl) return sede.mapUrl;
  if (!sede.address) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`CEIUM ${sede.address}`)}`;
}

/** Día de una sesión (mediodía en Caracas para que la fecha no se corra por zona horaria). */
export function sessionDay(date: string): Date {
  return new Date(`${date}T12:00:00-04:00`);
}
