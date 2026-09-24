// Calendario (.ics) de la cohorte del pedido: una entrada por sesión presencial (con hora si la cohorte la
// tiene; si no, de día completo) en la dirección de la sede. «Agregar al calendario» de la página del pedido.
// Solo pedidos vigentes con ítems semipresenciales; un token inexistente o un pedido cerrado → 404.
import { prisma } from "@/server/db";
import { cohortSessions, type CohortSession } from "../cohort";

export const dynamic = "force-dynamic";

const CLOSED = ["CANCELLED", "EXPIRED", "REFUNDED", "REJECTED"];

function text(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
}
/** Plegado de líneas a 75 octetos (RFC 5545 §3.1). */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, "utf8") > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
    }
    cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}
const ymd = (d: string) => d.replace(/-/g, "");
function nextDay(d: string): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10).replace(/-/g, "");
}
/** Caracas es UTC−4 todo el año: 09:00 local → 13:00Z. */
function utc(date: string, time: string): string {
  const [h, m] = time.split(":").map(Number);
  const x = new Date(`${date}T00:00:00Z`);
  x.setUTCHours(h + 4, m || 0, 0, 0);
  return x.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const order = await prisma.order.findUnique({
    where: { token },
    select: { number: true, status: true, items: { where: { modality: "SEMIPRESENCIAL", cohortId: { not: null } }, select: { productTitle: true, cohort: { select: { id: true, name: true, startDate: true, endDate: true, sessions: true, sede: { select: { name: true, address: true } } } } } } },
  });
  if (!order || CLOSED.includes(order.status) || !order.items.some((i) => i.cohort)) {
    return new Response("No hay sesiones para agregar al calendario.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CEIUM//Pedido//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${text(`CEIUM · Pedido #${order.number}`)}`, "X-WR-TIMEZONE:America/Caracas"];
  const now = stamp();
  for (const it of order.items) {
    const c = it.cohort!;
    const location = [`CEIUM ${c.sede.name}`, c.sede.address].filter(Boolean).join(" — ");
    let sessions: CohortSession[] = cohortSessions(c.sessions);
    if (!sessions.length) sessions = [{ date: c.startDate.toISOString().slice(0, 10), title: `Inicio de ${c.name}` }];
    sessions.forEach((s, i) => {
      const when =
        s.startTime && /^\d{1,2}:\d{2}$/.test(s.startTime)
          ? [`DTSTART:${utc(s.date, s.startTime)}`, `DTEND:${utc(s.date, s.endTime && /^\d{1,2}:\d{2}$/.test(s.endTime) ? s.endTime : s.startTime.replace(/^(\d+)/, (h) => String(Math.min(23, Number(h) + 2))))}`]
          : [`DTSTART;VALUE=DATE:${ymd(s.date)}`, `DTEND;VALUE=DATE:${nextDay(s.date)}`];
      lines.push(
        "BEGIN:VEVENT",
        `UID:${c.id}-${i + 1}@ceium.net`,
        `DTSTAMP:${now}`,
        ...when,
        `SUMMARY:${text(`${s.title || "Sesión presencial"} · ${it.productTitle}`)}`,
        `LOCATION:${text(location)}`,
        `DESCRIPTION:${text(`${c.name} · Sede ${c.sede.name} · Pedido #${order.number}`)}`,
        "END:VEVENT",
      );
    });
  }
  lines.push("END:VCALENDAR");
  return new Response(lines.map(fold).join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="ceium-pedido-${order.number}.ics"`,
      "cache-control": "no-store",
    },
  });
}
