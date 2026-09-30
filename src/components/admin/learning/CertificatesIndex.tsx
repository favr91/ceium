"use client";
// Índice de Certificados: pestañas (Emitidos, En curso, Bloqueados por saldo, Revocados) con conteo, búsqueda
// y filtro por diplomado en la URL. Emitidos: código verificable, entrega (PDF + correo), descargar, reenviar,
// revocar con motivo. En curso / bloqueados: avance por curso (segmentos), saldo y «Revisar ahora» en Moodle.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { CertificatesIndex as Data } from "@/server/admin-learning";
import { checkCertificateAction, resendCertificateAction, revokeCertificateAction } from "@/app/admin/(panel)/certificates/actions";
import { Icon } from "../Icon";
import { Modal } from "../ui";
import { Badge, Copy, Spinner } from "../orders/bits";
import { inSentenceDate, listDate, usd } from "../orders/format";
import { Avatar, Segments, ago, dm, useRun } from "./shared";

export interface CertState { view: string; q: string; diploma: string }

export function certQuery(s: CertState, patch: Partial<CertState> = {}) {
  const n = { ...s, ...patch };
  const p = new URLSearchParams();
  if (n.view !== "ISSUED") p.set("view", n.view);
  if (n.q) p.set("q", n.q);
  if (n.diploma) p.set("diploma", n.diploma);
  const q = p.toString();
  return q ? `?${q}` : "";
}

const VIEWS: { key: string; label: string }[] = [
  { key: "ISSUED", label: "Emitidos" },
  { key: "IN_PROGRESS", label: "En curso" },
  { key: "BLOCKED", label: "Bloqueados por saldo" },
  { key: "REVOKED", label: "Revocados" },
];

export function CertificatesIndex({ data, state, now, perms }: { data: Data; state: CertState; now: string; perms: { manage: boolean; resend: boolean; revoke: boolean } }) {
  const router = useRouter();
  const path = usePathname();
  const [pendingNav, startNav] = useTransition();
  const [q, setQ] = useState(state.q);
  const [searchOpen, setSearchOpen] = useState(!!state.q || !!state.diploma);
  const [revoke, setRevoke] = useState<{ id: string; code: string; name: string } | null>(null);
  const [reason, setReason] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { run, busy, toastNode } = useRun();
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const go = (patch: Partial<CertState>) => startNav(() => router.push(`${path}${certQuery(stateRef.current, patch)}`, { scroll: false }));
  useEffect(() => {
    if (q.trim() === state.q) return;
    const t = setTimeout(() => go({ q: q.trim() }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const filtered = !!state.q || !!state.diploma;
  const isCert = state.view === "ISSUED" || state.view === "REVOKED";
  const n = isCert ? data.certificates.length : data.purchases.length;

  return (
    <div className="oi-card" aria-busy={pendingNav}>
      <div className="oi-top">
        <nav className="ix-tabs" aria-label="Vistas de certificados" role="tablist">
          {VIEWS.map((v) => {
            const active = v.key === state.view;
            const c = data.counts[v.key as keyof typeof data.counts] ?? 0;
            return (
              <Link key={v.key} role="tab" aria-selected={active} href={`${path}${certQuery(state, { view: v.key })}`} className={`ix-tab${active ? " active" : ""}`} scroll={false}>
                {v.label}
                {c > 0 ? <span className={`n${v.key === "BLOCKED" ? " hot" : ""}`}>{c}</span> : null}
              </Link>
            );
          })}
        </nav>
        <div className="oi-tools">
          <button type="button" className={`oi-tool${searchOpen ? " on" : ""}`} aria-label="Buscar y filtrar" aria-expanded={searchOpen} onClick={() => { setSearchOpen((v) => !v); setTimeout(() => inputRef.current?.focus(), 0); }}>
            <Icon name="search" size={16} />
            <Icon name="filter" size={16} />
          </button>
        </div>
      </div>
      {searchOpen ? (
        <>
          <div className="oi-search">
            <form className="ix-search" role="search" onSubmit={(e) => { e.preventDefault(); go({ q: q.trim() }); }}>
              <Icon name="search" />
              <input ref={inputRef} className="inp" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por médico, correo, diplomado o código" aria-label="Buscar certificados" />
            </form>
            <button type="button" className="btn btn-tertiary" onClick={() => { setSearchOpen(false); setQ(""); if (filtered) go({ q: "", diploma: "" }); }}>Cancelar</button>
          </div>
          <div className="oi-filters">
            <label className="lx-select">
              <span className="sr-only">Diplomado</span>
              <select className="inp" value={state.diploma} onChange={(e) => go({ diploma: e.target.value })} aria-label="Diplomado">
                <option value="">Todos los diplomados</option>
                {data.diplomas.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
              </select>
            </label>
            {filtered ? <button type="button" className="btn btn-plain clear" onClick={() => { setQ(""); go({ q: "", diploma: "" }); }}>Borrar todo</button> : null}
          </div>
        </>
      ) : null}

      {n === 0 ? (
        <div className="ix-empty">
          <svg width="60" height="60" viewBox="0 0 60 60" aria-hidden="true">
            <circle cx="30" cy="30" r="28" fill="#f1f1f1" />
            <path d="M17 18h26v18H17V18Zm6 6h14M23 29h8M26 36v8l4-2 4 2v-8" fill="none" stroke="#8a8a8a" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          <h3>
            {filtered ? "Ningún resultado coincide con la búsqueda"
              : state.view === "ISSUED" ? "Aún no se ha emitido ningún certificado"
              : state.view === "IN_PROGRESS" ? "No hay médicos cursando un diplomado"
              : state.view === "BLOCKED" ? "Ningún certificado está bloqueado por saldo"
              : "No hay certificados revocados"}
          </h3>
          <p className="muted">
            {state.view === "ISSUED" ? "El certificado se emite solo cuando Moodle reporta completados todos los cursos del diplomado y el saldo es cero." : state.view === "BLOCKED" ? "Aquí aparecen quienes completaron todos los cursos, pero aún deben parte del diplomado." : ""}
          </p>
        </div>
      ) : isCert ? (
        <>
          <div className="oi-table" style={{ opacity: pendingNav ? 0.6 : 1 }}>
            <table className="ix" data-testid="certificates-table">
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Médico</th>
                  <th>Diplomado</th>
                  <th>{state.view === "REVOKED" ? "Revocado" : "Emitido"}</th>
                  <th>{state.view === "REVOKED" ? "Motivo" : "Entrega"}</th>
                  <th className="h-md">Pedido</th>
                  {state.view === "ISSUED" ? <th className="num"><span className="sr-only">Acciones</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {data.certificates.map((c) => (
                  <tr key={c.id} data-code={c.code}>
                    <td>
                      <Copy text={c.code} label="Copiar código">
                        <a className="ce-code lp-mono" href={`/certificados/${encodeURIComponent(c.code)}`} target="_blank" rel="noreferrer" title="Abrir la verificación pública">{c.code}</a>
                      </Copy>
                    </td>
                    <td className="lx-user">
                      <div className="lx-cell-user">
                        <Avatar name={c.customer.name} />
                        <span className="nm">
                          <Link href={`/admin/customers/${c.customer.id}`}>{c.customer.name}</Link>
                          <small>{c.customer.email}</small>
                        </span>
                      </div>
                    </td>
                    <td className="lx-course"><span className="t">{c.diploma.title}</span></td>
                    <td className="lx-when" title={listDate(state.view === "REVOKED" ? c.revokedAt! : c.issuedAt, now)}>{dm(state.view === "REVOKED" ? c.revokedAt! : c.issuedAt, now)}</td>
                    <td>
                      {state.view === "REVOKED" ? (
                        <span className="ce-reason">{c.revokeReason}</span>
                      ) : (
                        <span className="ce-deliv" data-testid="delivery">
                          <span className={c.hasPdf ? "ok" : "no"}><Icon name={c.hasPdf ? "check" : "alert"} size={14} /> PDF</span>
                          <span className={c.emailedAt ? "ok" : "no"} title={c.emailedAt ? `Enviado ${inSentenceDate(c.emailedAt, now)}` : "Correo pendiente"}><Icon name={c.emailedAt ? "check" : "alert"} size={14} /> Correo</span>
                        </span>
                      )}
                    </td>
                    <td className="h-md">{c.order ? <Link className="lk" href={`/admin/orders/${c.order.id}`}>#{c.order.number}</Link> : "—"}</td>
                    {state.view === "ISSUED" ? (
                      <td className="num">
                        <div className="lx-acts">
                          <a className="btn btn-tertiary btn-icon" href={`/admin/certificates/${c.id}/pdf?download=1`} aria-label={`Descargar PDF de ${c.code}`} title="Descargar PDF">
                            <Icon name="download" size={18} />
                          </a>
                          {perms.resend ? (
                            <button type="button" className="btn btn-tertiary btn-icon" aria-label={`Reenviar ${c.code} por correo`} title="Reenviar por correo" disabled={!!busy} onClick={() => run(`mail:${c.id}`, () => resendCertificateAction(c.id))}>
                              {busy === `mail:${c.id}` ? <Spinner /> : <Icon name="mail" size={18} />}
                            </button>
                          ) : null}
                          {perms.revoke ? (
                            <button type="button" className="btn btn-tertiary btn-icon" aria-label={`Revocar ${c.code}`} title="Revocar" onClick={() => { setReason(""); setRevoke({ id: c.id, code: c.code, name: c.customer.name }); }}>
                              <Icon name="x" size={18} />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="oi-list" data-testid="certificates-list">
            {data.certificates.map((c) => (
              <li key={c.id}>
                <div className="lx-l" style={{ gridTemplateColumns: "1fr auto" }}>
                  <Link className="m" href={`/admin/customers/${c.customer.id}`}>
                    <span className="t">{c.customer.name}</span>
                    <span className="c">{c.diploma.title}</span>
                    <span className="p lp-mono">{c.code}</span>
                    <span className="b">
                      {state.view === "REVOKED" ? <Badge spec={{ label: "Revocado", tone: "critical", progress: null }} /> : <Badge spec={{ label: c.emailedAt ? "Entregado" : "Sin entregar", tone: c.emailedAt ? "success" : "attention", progress: c.emailedAt ? "complete" : "partial" }} />}
                    </span>
                  </Link>
                  <span className="r">
                    {dm(state.view === "REVOKED" ? c.revokedAt! : c.issuedAt, now)}
                    {state.view === "ISSUED" ? (
                      <>
                        <br />
                        <a className="lk" href={`/admin/certificates/${c.id}/pdf?download=1`}>PDF</a>
                      </>
                    ) : null}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="oi-table" style={{ opacity: pendingNav ? 0.6 : 1 }}>
            <table className="ix" data-testid="progress-table">
              <thead>
                <tr>
                  <th>Médico</th>
                  <th>Diplomado</th>
                  <th>Cursos completados</th>
                  <th className="num">Saldo</th>
                  <th>Última consulta</th>
                  {perms.manage ? <th className="num"><span className="sr-only">Acciones</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {data.purchases.map((p) => (
                  <tr key={p.orderItemId} data-customer={p.customer.id}>
                    <td className="lx-user">
                      <div className="lx-cell-user">
                        <Avatar name={p.customer.name} />
                        <span className="nm">
                          <Link href={`/admin/customers/${p.customer.id}`}>{p.customer.name}</Link>
                          <small>{p.customer.email}</small>
                        </span>
                      </div>
                    </td>
                    <td className="lx-course">
                      <span className="t">{p.diploma.title}</span>
                      <span className="s">
                        <Link className="lk" href={`/admin/orders/${p.orderId}`}>#{p.orderNumber}</Link>
                        {p.monthly ? " · Mes a mes" : ""}
                      </span>
                    </td>
                    <td className="lx-prog">
                      <div className="row">
                        <Segments states={p.courses.map((c) => c.state)} label={p.diploma.title} />
                        <span className="n" data-testid="progress-count">{p.completed} de {p.total}</span>
                      </div>
                    </td>
                    <td className="num">{p.balanceCents > 0 ? <Badge spec={{ label: usd(p.balanceCents), tone: "attention", progress: "partial" }} /> : <span className="muted">Pagado</span>}</td>
                    <td className="lx-when">{ago(p.lastCheckedAt, now)}</td>
                    {perms.manage ? (
                      <td className="num">
                        <button type="button" className="btn" disabled={!!busy} onClick={() => run(`chk:${p.orderItemId}`, () => checkCertificateAction(p.customer.id, p.diploma.id))}>
                          {busy === `chk:${p.orderItemId}` ? <Spinner /> : null} Revisar ahora
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="oi-list" data-testid="progress-list">
            {data.purchases.map((p) => (
              <li key={p.orderItemId}>
                <div className="lx-l" style={{ gridTemplateColumns: "1fr auto" }}>
                  <Link className="m" href={`/admin/customers/${p.customer.id}`}>
                    <span className="t">{p.customer.name}</span>
                    <span className="c">{p.diploma.title}</span>
                    <Segments states={p.courses.map((c) => c.state)} label={p.diploma.title} />
                    <span className="p">{p.completed} de {p.total} cursos · {p.balanceCents > 0 ? `saldo ${usd(p.balanceCents)}` : "pagado"}</span>
                  </Link>
                  {perms.manage ? (
                    <button type="button" className="btn" disabled={!!busy} onClick={() => run(`chk:${p.orderItemId}`, () => checkCertificateAction(p.customer.id, p.diploma.id))}>
                      Revisar
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="oi-foot">
        <span>{n} {isCert ? (n === 1 ? "certificado" : "certificados") : n === 1 ? "médico" : "médicos"}</span>
      </div>

      {revoke ? (
        <Modal
          title={`Revocar ${revoke.code}`}
          onClose={() => setRevoke(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRevoke(null)}>Cancelar</button>
              <button
                type="button"
                className="btn btn-critical"
                disabled={!reason.trim() || !!busy}
                onClick={async () => {
                  const r = await run("revoke", () => revokeCertificateAction(revoke.id, reason));
                  if (r.ok) setRevoke(null);
                }}
              >
                {busy === "revoke" ? <Spinner /> : null} Revocar certificado
              </button>
            </>
          }
        >
          <p>
            El certificado de <b>{revoke.name}</b> dejará de ser válido: la verificación pública lo mostrará como revocado. Queda registrado en el historial del pedido.
          </p>
          <label className="field" style={{ marginTop: 12 }}>
            <span>Motivo</span>
            <textarea className="inp" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Por ejemplo: reembolso del diplomado" autoFocus />
          </label>
        </Modal>
      ) : null}
      {toastNode}
    </div>
  );
}
