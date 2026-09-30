// Página del pedido para el comprador (/pedido/[token]) — la «página de gracias» del checkout de Shopify de
// ceium.net, con lo que CEIUM necesita: estado del pago, acceso al aula virtual (Moodle), cupo de la cohorte,
// cuotas y cómo pagar lo que falta. Mismo layout que el checkout (formulario a la izquierda, resumen gris a la
// derecha; en móvil, resumen desplegable arriba). Destino de:
//   - return/cancel de PayPal: ?paypal=completado|pendiente|fallido|no-cobrado|no-cobrado-verificacion|cancelado|error
//   - errores al iniciar un pago: ?pago=error&motivo=…   · pago manual registrado: ?pago=registrado
//   - enlace «estado de tu pedido» de los correos
//   - enlace de pago manual de una cuota: ?cuota=<installmentId>#pagar  · método preseleccionado: ?metodo=PAGO_MOVIL
// El estado sale SIEMPRE de la BD; los parámetros solo agregan avisos (cancelado, fallido…). Mientras algo está en
// curso (PayPal revisando el pago, acceso al aula en preparación) la página se actualiza sola.
import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/server/db";
import { configFromEnv } from "@/server/deps";
import { formatDate, formatVES } from "@/server/email/templates";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { HoldCountdown } from "@/components/checkout/HoldCountdown";
import { LiveRefresh } from "@/components/checkout/LiveRefresh";
import { usd } from "@/components/checkout/OrderSummary";
import { PaypalButton } from "@/components/checkout/paypal";
import { BankIcon, CalendarIcon, CheckIcon, ChevronDownIcon, ClockIcon, FieldErrorIcon, LockIcon, MailIcon, MapPinIcon, PayPalWordmark } from "@/components/checkout/icons";
import { CopyButton } from "@/components/checkout/ManualPayment";
import { methodInText, PROOF_ACCEPT } from "@/components/checkout/manual-payment-fields";
import { cohortSessions, directionsUrl, sessionDay } from "./cohort";
import { DETAIL_LABELS } from "../../checkout/data";
import { payOrderWithPaypal, reportManualPayment } from "./actions";
import { maskCedula, maskPhone } from "@/components/checkout/mask";
import { verifiedMessage } from "@/server/flash";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tu pedido", robots: { index: false, follow: false } };

const STATUS: Record<string, string> = {
  PENDING_PAYMENT: "Pendiente de pago",
  AWAITING_VERIFICATION: "Pago en verificación",
  PARTIALLY_PAID: "Pago parcial recibido",
  PAID: "Pagado",
  ENROLLED: "Inscrito",
  REJECTED: "Pago rechazado",
  CANCELLED: "Pedido cancelado",
  EXPIRED: "Pedido vencido",
  REFUNDED: "Pedido reembolsado",
};
const CLOSED_TEXT: Record<string, string> = {
  CANCELLED: "Este pedido fue cancelado y su cupo quedó libre.",
  EXPIRED: "Pasó el plazo para pagar este pedido y su cupo quedó libre. Puedes volver a inscribirte desde la tienda.",
  REFUNDED: "Reembolsamos este pedido. El reintegro puede tardar unos días en verse en tu cuenta.",
  REJECTED: "No pudimos aprobar el pago de este pedido. Escríbenos y te ayudamos a completarlo.",
};
const INSTALLMENT: Record<string, string> = { PENDING: "Pendiente", PAID: "Pagada", OVERDUE: "Vencida", WAIVED: "Exonerada" };
const METHOD_FALLBACK: Record<string, string> = { PAYPAL: "PayPal", PAGO_MOVIL: "Pago Móvil", TRANSFERENCIA: "Transferencia bancaria", ZELLE: "Zelle", EFECTIVO: "Pago en efectivo" };
const PAID_STATES = ["PAID", "PARTIALLY_PAID", "ENROLLED"];

const PAYPAL_BANNER: Record<string, { tone: "ok" | "info" | "error"; text: string }> = {
  completado: { tone: "ok", text: "¡Pago recibido! Te enviamos la confirmación y el acceso a la plataforma por correo." },
  fallido: { tone: "error", text: "PayPal no aprobó el pago y no se te cobró nada. Puedes intentarlo de nuevo o elegir otro método." },
  "no-cobrado-verificacion": {
    tone: "info",
    text: "Aprobaste el pago en PayPal, pero no lo cobramos: este pedido ya tiene un pago en verificación (tu comprobante). No se te cobró nada por PayPal. Te avisaremos por correo en cuanto lo verifiquemos.",
  },
  "no-cobrado": { tone: "info", text: "Aprobaste el pago en PayPal, pero no lo cobramos porque este pedido ya no puede recibir ese pago. No se te cobró nada por PayPal; si tienes dudas, escríbenos." },
  cancelado: { tone: "info", text: "No se completó el pago en PayPal y no se te cobró nada. Tu pedido sigue abierto: puedes pagarlo cuando quieras." },
  error: { tone: "error", text: "No pudimos confirmar el pago con PayPal. Si se te cobró, no pagues de nuevo: lo confirmaremos automáticamente o escríbenos y lo revisamos." },
};

function Banner({ tone, children }: { tone: "ok" | "info" | "error"; children: React.ReactNode }) {
  return (
    <div className={`co-banner${tone === "ok" ? " co-banner-ok" : tone === "info" ? " co-banner-info" : ""}`} role={tone === "error" ? "alert" : "status"} data-testid="order-banner">
      {tone === "ok" ? <CheckIcon /> : tone === "info" ? <ClockIcon /> : <FieldErrorIcon />}
      <p>{children}</p>
    </div>
  );
}

/** Distintivo del método de pago (como el de la tarjeta en la página de gracias de Shopify). */
function MethodBadge({ method }: { method: string }) {
  return method === "PAYPAL" ? (
    <span className="co-pm-badge co-pm-paypal" aria-hidden="true">
      <PayPalWordmark />
    </span>
  ) : (
    <span className="co-pm-badge" aria-hidden="true">
      <BankIcon />
    </span>
  );
}

/** Correo partible antes de «@» (no a mitad de palabra) en columnas estrechas. */
function Email({ value }: { value: string }) {
  const at = value.indexOf("@");
  if (at < 0) return <>{value}</>;
  return (
    <>
      {value.slice(0, at)}
      <wbr />
      {value.slice(at)}
    </>
  );
}

const TZ = "America/Caracas";
function weekdayDate(d: Date): string {
  const s = new Intl.DateTimeFormat("es-VE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ }).format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function sentAt(d: Date): string {
  const day = new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", timeZone: TZ }).format(d).replace(/\./g, "");
  const time = new Intl.DateTimeFormat("es-VE", { hour: "numeric", minute: "2-digit", timeZone: TZ }).format(d);
  return `${day}, ${time}`;
}

/** Asunto del correo sin el número de pedido (ya está en la cabecera de la página). */
function updateTitle(subject: string, n: number): string {
  return subject.replace(new RegExp(`\\s*[—-]\\s*Pedido #${n}`), "").replace(new RegExp(`(tu pedido) #${n}`, "i"), "$1");
}

function shortDate(d: Date): string {
  return new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Caracas" }).format(d).replace(/\./g, "");
}

type StepState = "done" | "active" | "todo";
function Step({ state, title, children, testId }: { state: StepState; title: string; children?: React.ReactNode; testId?: string }) {
  return (
    <li data-state={state} aria-current={state === "active" ? "step" : undefined} data-testid={testId}>
      <span className="co-step-dot" aria-hidden="true">
        {state === "done" ? <CheckIcon /> : null}
      </span>
      <div>
        <p className="co-step-title">{title}</p>
        {children ? <div className="co-step-text">{children}</div> : null}
      </div>
    </li>
  );
}

export default async function OrderPage({ params, searchParams }: PageProps<"/pedido/[token]">) {
  const { token } = await params;
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) ?? null;
  const s = services();
  let order: Awaited<ReturnType<typeof s.orders.getOrderByToken>> | null;
  try {
    order = await s.orders.getOrderByToken(token);
  } catch (e) {
    if (!isDomainError(e)) throw e;
    order = null;
  }
  if (!order) {
    return (
      <main className="co-process" id="co-main">
        <div className="co-process-card">
          <h1 className="co-process-title">Pedido no encontrado</h1>
          <p className="co-process-text">Revisa el enlace del correo o escríbenos para ayudarte.</p>
          <p className="co-process-foot">
            <Link href="/pages/contacto">Contacto</Link> · <Link href="/">Volver a la tienda</Link>
          </p>
        </div>
      </main>
    );
  }

  const paypal = one("paypal");
  const pago = one("pago");
  // Solo mensajes firmados por el servidor (un enlace armado por otro muestra el texto genérico).
  const motivo = verifiedMessage(one("motivo"), one("firma"));
  const cuotaId = one("cuota");
  const metodo = one("metodo")?.toUpperCase() ?? null;
  const cuota = cuotaId ? order.installments.find((i) => i.id === cuotaId) ?? null : null;
  const nextIns = order.installments.find((i) => i.status === "PENDING" || i.status === "OVERDUE") ?? null;
  const target = cuota && (cuota.status === "PENDING" || cuota.status === "OVERDUE") ? cuota : nextIns;

  const closed = ["CANCELLED", "EXPIRED", "REFUNDED", "REJECTED"].includes(order.status);
  const paid = PAID_STATES.includes(order.status);
  const awaiting = order.payments.some((p) => p.status === "AWAITING_VERIFICATION");
  const proof = order.payments.filter((p) => p.status === "AWAITING_VERIFICATION").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  const reviewing = order.payments.some((p) => p.method === "PAYPAL" && p.status === "PENDING" && p.providerStatus === "CAPTURE_PENDING");
  // Primer pago: pendiente o con el comprobante en verificación (mientras se verifica no se ofrece pagar otra vez).
  const firstPayment = order.status === "PENDING_PAYMENT" || order.status === "AWAITING_VERIFICATION";
  const amountDueCents = closed
    ? 0
    : firstPayment
      ? Math.max(0, order.dueNowCents - order.amountPaidCents)
      : target
        ? Math.max(0, Math.min(target.amountCents - target.paidCents, order.balanceCents))
        : Math.max(0, order.balanceCents);
  // Mientras se verifica un pago (el primero o el de una cuota) no se ofrece pagar otra vez: el médico pagaría dos
  // veces la misma cuota (el servicio rechaza PayPal; un segundo Pago Móvil ya habría salido de su banco).
  const canPay = !closed && amountDueCents > 0 && !awaiting && !reviewing;
  const blockedCuota = cuota && target && cuota.id !== target.id && (cuota.status === "PENDING" || cuota.status === "OVERDUE") ? target : null;

  const productIds = [...new Set(order.items.map((i) => i.productId))];
  const [options, images, enrollments, mails] = await Promise.all([
    s.orders.listPaymentOptions(),
    prisma.productImage.findMany({ where: { productId: { in: productIds } }, orderBy: { position: "asc" }, select: { productId: true, url: true, alt: true } }),
    prisma.enrollment.findMany({ where: { orderId: order.id, status: { not: "UNENROLLED" } }, select: { status: true, product: { select: { title: true } } } }),
    // «Novedades del pedido»: los correos que ya le llegaron al médico (como «Order updates» de Shopify).
    prisma.emailOutbox.findMany({ where: { orderId: order.id, status: "SENT" }, orderBy: { sentAt: "desc" }, take: 12, select: { id: true, subject: true, sentAt: true, to: true } }),
  ]);
  const payOptions = canPay ? options : [];
  const hasPaypal = payOptions.some((o) => o.method === "PAYPAL");
  const manual = payOptions.filter((o) => o.method !== "PAYPAL");
  const methodLabel = (m: string | null) => (m ? options.find((o) => o.method === m)?.label ?? METHOD_FALLBACK[m] ?? m : "");
  const payPaypal = payOrderWithPaypal.bind(null, token, !firstPayment && target ? target.id : null);
  const payManual = reportManualPayment.bind(null, token, cuotaId);
  const imageOf = (productId: string) => images.find((i) => i.productId === productId) ?? null;

  const c = order.customer;
  const firstName = (order.buyerFirstName ?? c.firstName).split(/\s+/)[0];
  const completed = order.payments.filter((p) => p.status === "COMPLETED" || p.status === "PARTIALLY_REFUNDED").sort((a, b) => (b.paidAt ?? b.updatedAt).getTime() - (a.paidAt ?? a.updatedAt).getTime());
  const lastPaid = completed[0] ?? null;
  const lastIns = lastPaid?.installmentId && order.installments.length > 1 ? order.installments.find((i) => i.id === lastPaid.installmentId) ?? null : null;
  const semiItems = order.items.filter((i) => i.modality === "SEMIPRESENCIAL" && i.cohort);
  const liveHolds = order.items.map((i) => i.reservation).filter((r) => r && r.status === "HELD").map((r) => r!.expiresAt).sort((a, b) => a.getTime() - b.getTime());
  const enrolledCourses = enrollments.filter((e) => e.status === "ENROLLED").map((e) => e.product.title);
  const accessReady = enrollments.length > 0 && enrollments.every((e) => e.status === "ENROLLED");
  const preparingAccess = paid && !accessReady;
  const moodleLoginUrl = configFromEnv().moodleLoginUrl;
  const installmentsPlan = order.installments.length > 1;

  const tone: "ok" | "wait" | "warn" = paid ? "ok" : closed ? "warn" : "wait";
  const title = paid ? `¡Gracias, ${firstName}!` : reviewing ? "Tu pago está en revisión" : awaiting ? "Pago en verificación" : STATUS[order.status] ?? order.status;
  const paidBanner = paypal === "completado" && paid;
  const banner = paypal && PAYPAL_BANNER[paypal] && !paidBanner ? PAYPAL_BANNER[paypal] : null;
  const totalShown = paid || closed ? order.totalCents : Math.max(0, order.dueNowCents - order.amountPaidCents);

  const cohortCards = semiItems
    .filter((it) => paid || it.reservation?.status === "HELD")
    .map((it) => {
      const co = it.cohort!;
      const sessions = cohortSessions(co.sessions);
      const maps = directionsUrl(it.sede);
      return (
        <section key={it.id} className="co-card co-cohort" aria-labelledby={`co-cohort-${it.id}`} data-testid="order-cohort">
          <p className="co-cohort-eyebrow">{paid ? "Tu cohorte" : "Cupo apartado"}</p>
          <h2 id={`co-cohort-${it.id}`} className="co-card-title">
            {co.name}
            {it.sede ? ` · Sede ${it.sede.name}` : ""}
          </h2>
          <p className="co-card-text">{it.productTitle}</p>
          <div className="co-cohort-dates">
            <div>
              <span>Inicio</span>
              <strong>{weekdayDate(co.startDate)}</strong>
              <small>{formatDate(co.startDate)}</small>
            </div>
            <div>
              <span>Fin</span>
              <strong>{weekdayDate(co.endDate)}</strong>
              <small>{formatDate(co.endDate)}</small>
            </div>
          </div>
          {it.sede?.address ? (
            <p className="co-cohort-addr">
              <MapPinIcon />
              <span>{it.sede.address}</span>
            </p>
          ) : null}
          {sessions.length ? (
            <details className="co-sessions" open={sessions.length <= 4}>
              <summary>
                {sessions.length === 1 ? "1 sesión presencial" : `${sessions.length} sesiones presenciales`}
                <ChevronDownIcon />
              </summary>
              <ol>
                {sessions.map((ss, i) => {
                  const day = sessionDay(ss.date);
                  return (
                    <li key={`${ss.date}-${i}`}>
                      <span className="co-date-chip" aria-hidden="true">
                        <small>{new Intl.DateTimeFormat("es-VE", { month: "short", timeZone: TZ }).format(day).replace(".", "")}</small>
                        <b>{new Intl.DateTimeFormat("es-VE", { day: "numeric", timeZone: TZ }).format(day)}</b>
                      </span>
                      <span>
                        <strong>{ss.title || "Sesión presencial"}</strong>
                        <small>
                          {weekdayDate(day)}
                          {ss.startTime ? ` · ${ss.startTime}${ss.endTime ? `–${ss.endTime}` : ""}` : ""}
                        </small>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </details>
          ) : null}
          <div className="co-cohort-actions">
            <a className="co-btn-line" href={`/pedido/${token}/calendario`} download data-testid="cohort-ics">
              <CalendarIcon />
              Agregar al calendario
            </a>
            {maps ? (
              <a className="co-btn-line" href={maps} target="_blank" rel="noopener noreferrer">
                <MapPinIcon />
                Cómo llegar
              </a>
            ) : null}
          </div>
        </section>
      );
    });

  const summary = (
    <>
      <ul className="co-lines" aria-label="Programas">
        {order.items.map((it) => {
          const img = imageOf(it.productId);
          const variant = [it.modality === "ONLINE" ? "Online" : "Semipresencial", it.sede?.name, it.planLabel].filter(Boolean).join(" / ");
          return (
            <li key={it.id} className="co-line" data-testid="summary-line">
              <div className="co-thumb">
                {img ? (
                  // eslint-disable-next-line @next/next/no-img-element -- miniatura del CDN del catálogo
                  <img src={img.url} alt={img.alt ?? it.productTitle} width={64} height={64} />
                ) : (
                  <span className="co-thumb-empty" aria-hidden="true" />
                )}
                <span className="co-qty" aria-label={`Cantidad: ${it.quantity}`}>
                  {it.quantity}
                </span>
              </div>
              <div className="co-line-body">
                <p className="co-line-title">{it.productTitle}</p>
                <p className="co-line-variant">{variant}</p>
                {it.cohort ? (
                  <p className="co-line-cohort">
                    {it.cohort.name} · {shortDate(it.cohort.startDate)} – {shortDate(it.cohort.endDate)}
                  </p>
                ) : null}
              </div>
              <p className="co-line-price">
                {it.discountCents > 0 && it.planKind !== "MONTHLY" ? <s className="co-compare">{usd(it.unitPriceCents * it.quantity)}</s> : null}
                <span>{usd(it.totalCents)}</span>
              </p>
            </li>
          );
        })}
      </ul>
      <div className="co-costs" data-testid="order-costs">
        <div className="co-cost-row">
          <span>Subtotal · {order.items.length === 1 ? "1 programa" : `${order.items.length} programas`}</span>
          <span>{usd(order.subtotalCents)}</span>
        </div>
        {order.discountCents > 0 ? (
          <div className="co-cost-row co-cost-discount">
            <span>Descuento por forma de pago</span>
            <span>−{usd(order.discountCents)}</span>
          </div>
        ) : null}
        <div className="co-cost-total">
          <strong>Total</strong>
          <span className="co-total-amount">
            <span className="co-currency">USD</span>
            <strong>{usd(order.totalCents)}</strong>
          </span>
        </div>
        {order.amountPaidCents > 0 || order.totalCents !== order.dueNowCents ? (
          <div className="co-paid-rows">
            <div className="co-cost-row">
              <span>Pagado</span>
              <span data-testid="order-paid">{usd(order.amountPaidCents)}</span>
            </div>
            {paid && order.balanceCents <= 0 ? (
              <div className="co-cost-row co-cost-settled">
                <span>Saldo pendiente</span>
                <span data-testid="order-balance">
                  <CheckIcon /> Pagado por completo
                </span>
              </div>
            ) : (
              <div className="co-cost-row co-cost-strong">
                <span>Saldo pendiente</span>
                <span data-testid="order-balance">{usd(Math.max(0, order.balanceCents))}</span>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </>
  );

  return (
    <div className="co-page">
      <details className="co-msum">
        <summary className="co-msum-bar">
          <span className="co-msum-toggle">
            <span className="co-msum-show">Resumen del pedido</span>
            <span className="co-msum-hide">Ocultar resumen</span>
            <ChevronDownIcon />
          </span>
          <strong className="co-msum-total">{usd(totalShown)}</strong>
        </summary>
        <div className="co-msum-body">{summary}</div>
      </details>

      <div className="co-main" id="co-main">
        <div className="co-main-inner">
          <div className="co-ty">
            <header className="co-ty-head">
              <span className="co-ty-icon" data-tone={tone} aria-hidden="true">
                {tone === "ok" ? <CheckIcon /> : tone === "warn" ? <FieldErrorIcon /> : <ClockIcon />}
              </span>
              <div>
                <p className="co-ty-eyebrow">Pedido #{order.number}</p>
                <h1 className="co-ty-title" data-testid="order-title">
                  {title}
                </h1>
              </div>
            </header>

            {banner ? <Banner tone={banner.tone}>{banner.text}</Banner> : null}
            {pago === "error" ? <Banner tone="error">{motivo || "No pudimos procesar el pago. Intenta de nuevo."}</Banner> : null}
            {pago === "registrado" ? (
              <Banner tone="ok">
                Recibimos tu pago{proof ? ` por ${methodInText(proof.method, methodLabel(proof.method))}` : ""} y su comprobante. Te enviamos la confirmación a {c.email}.
              </Banner>
            ) : null}

            {paid ? (
              <section className="co-card" aria-labelledby="co-confirm-title" data-testid="order-confirmation">
                <h2 id="co-confirm-title" className="co-card-title">
                  {paidBanner ? "¡Pago recibido!" : order.status === "ENROLLED" ? "Tu inscripción está confirmada" : "Tu pago está confirmado"}
                </h2>
                <p className="co-card-text">
                  Te enviamos la confirmación{accessReady ? " y tu acceso al aula virtual" : ""} a <strong>{c.email}</strong>.
                </p>
                <ol className="co-steps">
                  <Step state="done" title={lastIns ? `Cuota ${lastIns.sequence} pagada` : "Pago confirmado"} testId="step-payment">
                    {lastPaid ? (
                      <>
                        {usd(lastPaid.amountUsdCents)} {lastPaid.method === "EFECTIVO" ? "en efectivo" : `por ${methodInText(lastPaid.method, methodLabel(lastPaid.method))}`}
                        {lastPaid.paidAt ? ` · ${formatDate(lastPaid.paidAt)}` : ""}
                        {lastIns?.course ? ` · ${lastIns.course.title}` : ""}
                      </>
                    ) : (
                      <>Pagado: {usd(order.amountPaidCents)}</>
                    )}
                    {order.balanceCents > 0 ? <> · Saldo pendiente: {usd(order.balanceCents)}</> : null}
                  </Step>
                  {semiItems.map((it) => (
                    <Step key={it.id} state="done" title="Cupo confirmado">
                      {it.cohort!.name} · {it.sede?.name ?? ""} · desde el {formatDate(it.cohort!.startDate)}. Te enviamos la dirección y el horario por correo.
                    </Step>
                  ))}
                  {preparingAccess ? (
                    <Step state="active" title="Preparando tu acceso al aula virtual" testId="step-access">
                      Te llegará por correo a {c.email} en unos minutos. Esta página se actualiza sola.
                    </Step>
                  ) : (
                    <Step state="done" title="Acceso al aula virtual" testId="step-access">
                      {c.moodleUsername ? (
                        <>
                          <span className="co-access-user">
                            <span>
                              Usuario: <strong data-testid="moodle-username">{c.moodleUsername}</strong>
                            </span>
                            <CopyButton value={c.moodleUsername} label="Usuario" />
                          </span>
                          Te enviamos los datos para entrar por correo.
                        </>
                      ) : (
                        "Te enviamos tu usuario y los datos para entrar por correo."
                      )}
                      {enrolledCourses.length ? (
                        <>
                          {" "}
                          {enrolledCourses.length === 1 ? "Curso habilitado" : "Cursos habilitados"}: {enrolledCourses.length > 3 ? `${enrolledCourses.length} cursos` : enrolledCourses.join(", ")}.
                        </>
                      ) : null}
                    </Step>
                  )}
                  <Step state="todo" title="Certificado">
                    Al aprobar {order.items.some((i) => i.productType === "DIPLOMA") ? "todos los cursos" : "el programa"}
                    {order.balanceCents > 0 ? " y completar el pago" : ""}, recibirás tu certificado con código de verificación.
                  </Step>
                </ol>
                {accessReady ? (
                  <a className="co-pay co-pay-inline" href={moodleLoginUrl} target="_blank" rel="noopener noreferrer">
                    Ir al aula virtual
                  </a>
                ) : null}
                {preparingAccess ? <LiveRefresh everyMs={3000} forMs={3 * 60_000} /> : null}
              </section>
            ) : reviewing ? (
              <section className="co-card" aria-labelledby="co-review-title" data-testid="order-reviewing">
                <h2 id="co-review-title" className="co-card-title">
                  PayPal está revisando tu pago
                </h2>
                <p className="co-card-text">
                  Suele tardar unos minutos. {liveHolds.length ? "Tu cupo se mantiene reservado y te" : "Te"} avisaremos por correo a <strong>{c.email}</strong> en cuanto se confirme. No hace falta pagar de nuevo.
                </p>
                <ol className="co-steps">
                  <Step state="done" title="Pago aprobado en PayPal" />
                  <Step state="active" title="Revisión de PayPal">
                    Esta página se actualiza sola.
                  </Step>
                  <Step state="todo" title="Acceso al aula virtual por correo" />
                </ol>
                <LiveRefresh everyMs={5000} forMs={15 * 60_000} />
              </section>
            ) : awaiting && proof ? (
              <section className="co-card" aria-labelledby="co-verify-title" data-testid="order-verifying">
                <h2 id="co-verify-title" className="co-card-title">
                  Estamos verificando tu pago
                </h2>
                <p className="co-card-text">
                  Recibimos tu comprobante. Lo confirmamos con el banco en horario laboral, normalmente el mismo día, y te avisaremos por correo a <strong>{c.email}</strong>. No hace falta que pagues de nuevo.
                </p>
                <ol className="co-steps">
                  {semiItems.map((it) =>
                    it.reservation?.status === "HELD" ? (
                      <Step key={it.id} state="done" title="Cupo apartado">
                        {it.cohort!.name} · {it.sede?.name ?? ""}. Lo mantenemos para ti mientras verificamos el pago.
                      </Step>
                    ) : null,
                  )}
                  <Step state="done" title="Comprobante recibido" testId="step-proof">
                    {methodLabel(proof.method)}
                    {proof.reference ? <> · ref. <strong>{proof.reference}</strong></> : null}
                    <br />
                    {proof.currency === "VES" ? (
                      <>
                        <strong>{formatVES(proof.amountCents)}</strong> ≈ {usd(proof.amountUsdCents)} USD
                      </>
                    ) : (
                      <strong>{usd(proof.amountCents)} USD</strong>
                    )}
                    {proof.paidAt ? ` · pagado el ${formatDate(proof.paidAt)}` : ""}
                    {proof.bank ? ` · desde ${proof.bank}` : ""}
                  </Step>
                  <Step state="active" title="Verificación del pago" testId="step-verify">
                    El equipo de CEIUM revisa tu comprobante. Esta página se actualiza sola.
                  </Step>
                  <Step state="todo" title="Acceso al aula virtual">
                    Al aprobar el pago, te enviaremos a {c.email} tu usuario de Moodle y los datos para entrar.
                  </Step>
                </ol>
                <LiveRefresh everyMs={20_000} forMs={30 * 60_000} />
              </section>
            ) : closed ? (
              <section className="co-card">
                <p className="co-card-text">{CLOSED_TEXT[order.status] ?? ""}</p>
              </section>
            ) : null}

            {cohortCards}

            {!canPay && paid && awaiting && proof && order.balanceCents > 0 ? (
              <section className="co-card" id="pagar" aria-labelledby="co-pay-verify-title" data-testid="order-pay-verifying">
                <h2 id="co-pay-verify-title" className="co-card-title">
                  {target ? `Cuota ${target.sequence}: pago en verificación` : "Pago en verificación"}
                </h2>
                <p className="co-card-text">
                  Recibimos tu pago por {methodInText(proof.method, methodLabel(proof.method))}
                  {proof.reference ? <>, ref. <strong>{proof.reference}</strong></> : null}. Lo confirmamos con el banco y te avisaremos por correo a <strong>{c.email}</strong>. No hace falta que pagues de nuevo.
                </p>
                <LiveRefresh everyMs={20_000} forMs={30 * 60_000} />
              </section>
            ) : null}

            {canPay ? (
              <section className="co-card" id="pagar" aria-labelledby="co-pay-title" data-testid="order-pay">
                <h2 id="co-pay-title" className="co-card-title">
                  {firstPayment ? "Completa tu pago" : target ? `Pagar la cuota ${target.sequence}${target.course ? ` · ${target.course.title}` : ""}` : "Pagar el saldo"}
                </h2>
                {blockedCuota ? <p className="co-card-text">Primero debes pagar la cuota {blockedCuota.sequence}.</p> : null}
                {firstPayment && liveHolds.length ? (
                  <div className="co-hold co-hold-compact" data-testid="hold-card">
                    <ClockIcon className="co-hold-icon" />
                    <p className="co-hold-text">Tu cupo está reservado. Completa el pago antes de que termine la reserva o se liberará para otro médico.</p>
                    <HoldCountdown expiresAt={liveHolds[0].toISOString()} serverNow={new Date().toISOString()} />
                  </div>
                ) : null}
                <dl className="co-amount">
                  <div>
                    <dt>Monto a pagar</dt>
                    <dd data-testid="amount-due">{usd(amountDueCents)} USD</dd>
                  </div>
                </dl>
                {hasPaypal ? (
                  <form action={payPaypal} className="co-pay-form">
                    <PaypalButton label={`Pagar ${usd(amountDueCents)} con PayPal`} handoff={{ amountLabel: `${usd(amountDueCents)} USD`, holdMinutes: null }} />
                    <p className="co-secure">
                      <LockIcon />
                      Pagarás en el sitio seguro de PayPal, con tu cuenta o con tarjeta, y volverás aquí para ver tu confirmación.
                    </p>
                  </form>
                ) : null}
                {manual.length ? (
                  <form action={payManual} encType="multipart/form-data" className="co-manual">
                    <h3 className="co-h3">¿Pagaste por pago móvil o transferencia?</h3>
                    {manual.map((m, idx) => (
                      <details key={m.method} open={metodo ? metodo === m.method : idx === 0} className="co-manual-method">
                        <summary>
                          <span>{m.label}</span>
                          {m.currency === "VES" && m.vesPerUsd ? <strong>{formatVES(Math.round(amountDueCents * m.vesPerUsd))}</strong> : <strong>{usd(amountDueCents)}</strong>}
                          <ChevronDownIcon />
                        </summary>
                        <dl className="co-bank">
                          {Object.entries(m.details ?? {}).map(([k, v]) => (
                            <div key={k}>
                              <dt>{DETAIL_LABELS[k] ?? k}</dt>
                              <dd>{v}</dd>
                            </div>
                          ))}
                        </dl>
                        {m.currency === "VES" && m.vesPerUsd ? <p className="co-instructions">Tasa: Bs. {m.vesPerUsd.toLocaleString("es-VE")} por USD.</p> : null}
                        {m.instructions ? <p className="co-instructions">{m.instructions}</p> : null}
                      </details>
                    ))}
                    <div className="co-grid">
                      <div className="co-cell">
                        <div className="co-field co-select">
                          <select id="method" name="method" required defaultValue={metodo && manual.some((m) => m.method === metodo) ? metodo : manual[0].method}>
                            {manual.map((m) => (
                              <option key={m.method} value={m.method}>
                                {m.label} ({m.currency === "VES" ? "Bs." : "USD"})
                              </option>
                            ))}
                          </select>
                          <label htmlFor="method">Método</label>
                          <ChevronDownIcon className="co-chevron" />
                        </div>
                      </div>
                      <div className="co-cell co-half">
                        <div className="co-field">
                          <input id="reference" name="reference" required inputMode="numeric" autoComplete="off" placeholder=" " />
                          <label htmlFor="reference">Número de referencia</label>
                        </div>
                      </div>
                      <div className="co-cell co-half">
                        <div className="co-field">
                          <input id="amount" name="amount" required inputMode="decimal" placeholder=" " />
                          <label htmlFor="amount">Monto pagado (en la moneda del método)</label>
                        </div>
                      </div>
                      <div className="co-cell co-half">
                        <div className="co-field">
                          <input id="bank" name="bank" placeholder=" " />
                          <label htmlFor="bank">Banco de origen</label>
                        </div>
                      </div>
                      <div className="co-cell co-half">
                        <div className="co-field">
                          <input id="paidAt" name="paidAt" type="date" placeholder=" " />
                          <label htmlFor="paidAt">Fecha del pago</label>
                        </div>
                      </div>
                      <div className="co-cell">
                        <div className="co-field">
                          <input id="payerCedula" name="payerCedula" placeholder=" " />
                          <label htmlFor="payerCedula">Cédula del titular</label>
                        </div>
                      </div>
                      <div className="co-cell">
                        <label htmlFor="proof" className="co-file-label">
                          Comprobante (imagen o PDF, máx. 10 MB)
                        </label>
                        <input id="proof" name="proof" type="file" accept={PROOF_ACCEPT} className="co-file" />
                      </div>
                    </div>
                    <button type="submit" className="co-pay">
                      Enviar datos del pago
                    </button>
                  </form>
                ) : null}
                {!hasPaypal && !manual.length ? <p className="co-card-text">En este momento no hay métodos de pago disponibles. Escríbenos para ayudarte.</p> : null}
              </section>
            ) : null}

            <section className="co-card" aria-labelledby="co-details-title">
              <h2 id="co-details-title" className="co-card-title">
                Detalles del pedido
              </h2>
              <div className="co-details" data-testid="order-details">
                <div>
                  <h3>Contacto</h3>
                  <p>
                    <Email value={c.email} />
                  </p>
                  {c.phone ? <p>{maskPhone(c.phone)}</p> : null}
                </div>
                <div>
                  <h3>Médico</h3>
                  <p>
                    {order.buyerFirstName ?? c.firstName} {order.buyerLastName ?? c.lastName}
                  </p>
                  {c.cedula ? <p>{maskCedula(c.cedula)}</p> : null}
                  {c.specialty ? <p>{c.specialty}</p> : null}
                </div>
                <div>
                  <h3>Método de pago</h3>
                  {completed.length ? (
                    completed.map((p) => (
                      <p key={p.id} className="co-pm">
                        <MethodBadge method={p.method} />
                        <span>
                          {methodLabel(p.method)} · {usd(p.amountUsdCents)}
                        </span>
                      </p>
                    ))
                  ) : (
                    <p className="co-pm">
                      {proof || order.paymentMethod ? <MethodBadge method={(proof?.method ?? order.paymentMethod)!} /> : null}
                      <span>{proof ? `${methodLabel(proof.method)} · en verificación` : order.paymentMethod ? `${methodLabel(order.paymentMethod)} · pendiente` : "Pendiente"}</span>
                    </p>
                  )}
                </div>
                <div>
                  <h3>Modalidad</h3>
                  {order.items.map((it) => (
                    <p key={it.id}>
                      {it.modality === "ONLINE" ? "Online" : `Semipresencial${it.sede ? ` · ${it.sede.name}` : ""}`}
                      {it.cohort ? ` · ${it.cohort.name}` : ""}
                      {it.planLabel ? ` · ${it.planLabel}` : ""}
                    </p>
                  ))}
                </div>
              </div>
              {awaiting && paid ? <p className="co-card-text co-card-note">Tenemos otro pago tuyo en verificación. Te avisaremos por correo al aprobarlo.</p> : null}
            </section>

            {installmentsPlan ? (
              <section className="co-card" aria-labelledby="co-ins-title">
                <h2 id="co-ins-title" className="co-card-title">
                  Cuotas
                </h2>
                <ol className="co-ins" data-testid="installments">
                  {order.installments.map((i) => (
                    <li key={i.id} id={`cuota-${i.id}`} data-current={cuota?.id === i.id || undefined}>
                      <span className="co-ins-name">
                        <strong>Cuota {i.sequence}</strong>
                        {i.course ? ` · ${i.course.title}` : ""}
                        {i.dueDate && i.status !== "PAID" && i.status !== "WAIVED" ? <small> · vence {formatDate(i.dueDate)}</small> : null}
                      </span>
                      <span className="co-ins-amount">{usd(i.amountCents)}</span>
                      <span className="co-ins-status" data-status={i.status}>
                        {INSTALLMENT[i.status] ?? i.status}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            <section className="co-card" aria-labelledby="co-updates-title" data-testid="order-updates">
              <h2 id="co-updates-title" className="co-card-title">
                Novedades del pedido
              </h2>
              <p className="co-card-text">
                Te avisamos por correo a <strong>{c.email}</strong> en cada paso: pago, acceso al aula virtual{semiItems.length ? ", datos de la cohorte" : ""} y certificado.
              </p>
              {mails.length ? (
                <ol className="co-updates">
                  {mails.map((m) => (
                    <li key={m.id} data-testid="order-update">
                      <MailIcon className="co-update-icon" />
                      <div>
                        <p className="co-update-subject">{updateTitle(m.subject, order.number)}</p>
                        <p className="co-update-meta">{m.sentAt ? `Enviado el ${sentAt(m.sentAt)}` : "Enviado"}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : null}
            </section>

            <div className="co-ty-actions">
              <p>
                ¿Necesitas ayuda? <Link href="/pages/contacto">Contáctanos</Link>
              </p>
              <Link href="/" className="co-pay co-pay-inline">
                Seguir explorando programas
              </Link>
            </div>
          </div>
          <footer className="co-footer">
            <Link href="/policies/privacy-policy">Política de privacidad</Link>
            <Link href="/pages/contacto">Contacto</Link>
          </footer>
        </div>
      </div>

      <aside className="co-aside" aria-label="Resumen del pedido">
        <div className="co-aside-inner">{summary}</div>
      </aside>
    </div>
  );
}
