"use client";
// Cronología del pedido (como la de Shopify): caja para comentar arriba y, debajo, todo lo que pasó agrupado
// por día (hoy, ayer, 20 de septiembre…), del más reciente al más antiguo, con detalle desplegable por evento.
import { useState } from "react";
import { Icon } from "../Icon";
import { addOrderNote } from "@/app/admin/(panel)/orders/actions";
import { Spinner } from "./bits";
import { useOrder } from "./context";
import { dayKey, dayLabel, eventDetails, eventKind, eventMessage, initials, time, type EventLike } from "./format";

export function Timeline({ orderId, events, customerName, adminName, now, onViewEmail }: { orderId: string; events: EventLike[]; customerName: string; adminName: string; now: string | Date; onViewEmail: (emailId: string) => void }) {
  const { run, busy, perms } = useOrder();
  const [text, setText] = useState("");
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const list = [...events].reverse();
  const groups: { key: string; label: string; items: EventLike[] }[] = [];
  for (const e of list) {
    const k = dayKey(e.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.key === k) last.items.push(e);
    else groups.push({ key: k, label: dayLabel(e.createdAt, now), items: [e] });
  }
  const toggle = (id: string) =>
    setOpenIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <section className="otl-sec" aria-labelledby="h-tl">
      <h2 id="h-tl">Cronología</h2>
      {perms.note ? (
        <form
          className="otl-compose"
          aria-label="Comentar"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            const r = await run("note", () => addOrderNote(orderId, text));
            if (r.ok) setText("");
          }}
        >
          <div className="row1">
            <span className="av" aria-hidden="true">{initials(adminName)}</span>
            <textarea
              aria-label="Comentario"
              placeholder="Deja un comentario…"
              value={text}
              maxLength={2000}
              rows={Math.min(6, Math.max(1, text.split("\n").length))}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit();
              }}
            />
          </div>
          <div className="bar">
            {text.length > 1800 ? <span className="count">{2000 - text.length}</span> : <span className="count" />}
            <button type="submit" className={`btn ${text.trim() ? "btn-primary" : ""}`} disabled={!text.trim() || busy === "note"}>
              {busy === "note" ? <Spinner /> : null}
              Publicar
            </button>
          </div>
        </form>
      ) : null}
      <p className="otl-note">Solo tú y el equipo de CEIUM pueden ver los comentarios.</p>
      <ol className="otl" data-testid="timeline">
        {groups.map((g) => (
          <li key={g.key} style={{ listStyle: "none" }}>
            <div className="day">{g.label}</div>
            <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {g.items.map((e) => {
                const kind = eventKind(e.type);
                const d = (e.data && typeof e.data === "object" ? e.data : {}) as Record<string, unknown>;
                if (kind === "comment" && e.actorType === "ADMIN") {
                  return (
                    <li key={e.id} className="ev comment" data-event={e.type}>
                      <span className="av" aria-hidden="true">{initials(e.actor?.name ?? "?")}</span>
                      <div className="txt">
                        <div className="bubble">
                          <div className="who">{e.actor?.name ?? "Panel"}</div>
                          {e.note}
                        </div>
                      </div>
                      <span className="tm">{time(e.createdAt)}</span>
                    </li>
                  );
                }
                const open = openIds.has(e.id);
                const details = eventDetails(e);
                const emailId = typeof d.emailId === "string" ? d.emailId : null;
                return (
                  <li key={e.id} className={`ev ${kind}`} data-event={e.type}>
                    <div className="txt">
                      <button type="button" className="more" aria-expanded={open} onClick={() => toggle(e.id)}>
                        <span>{eventMessage(e, { customerName })}</span>
                        <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
                      </button>
                      {emailId ? (
                        <>
                          {" "}
                          <button type="button" className="lnk" onClick={() => onViewEmail(emailId)}>
                            Ver correo
                          </button>
                        </>
                      ) : null}
                      {/* Siempre en el DOM (buscable, imprimible); visible al desplegar. */}
                      <dl className="dl" hidden={!open}>
                        {details.map(([k, v]) => (
                          <FragmentKV key={k} k={k} v={v} />
                        ))}
                      </dl>
                    </div>
                    <span className="tm">{time(e.createdAt)}</span>
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
        {groups.length === 0 ? <li className="ev">Sin actividad todavía.</li> : null}
      </ol>
    </section>
  );
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
