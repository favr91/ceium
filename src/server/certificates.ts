// Certificado de diplomado: se emite SOLO cuando Moodle reporta completados TODOS los cursos del
// diplomado (core_completion_get_course_completion_status) en matrículas VIGENTES (una finalización de una
// matrícula dada de baja, p.ej. tras un reembolso, no cuenta) Y el pedido tiene saldo 0. El saldo 0 es
// obligatorio (SPEC): no hay ajuste que lo desactive; para certificar a quien debe, el admin condona el saldo.
// Nunca dos veces (única por cliente+diplomado). PDF con pdf-lib y código verificable público.
// La entrega (PDF + correo) es recuperable: si falla, el barrido la reintenta.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Deps } from "@/server/deps";
import { withTx } from "@/server/deps";
import { DomainError, isUniqueViolation } from "@/server/errors";
import { addOrderEvent, SYSTEM } from "@/server/orders";
import { formatUSD } from "@/server/pricing";
import { deliverOutboxEmail, safeNotify, sendEmail } from "@/server/email";
import * as T from "@/server/email/templates";
import { requireAdmin, type SessionUser } from "@/server/auth";

export interface CompletionCheck {
  customerId: string;
  diplomaId: string;
  total: number;
  completed: number;
  /** moodleCourseId de los cursos aún no completados. */
  pendingCourseIds: number[];
  issued: boolean;
  alreadyIssued: boolean;
  certificateId?: string;
  code?: string;
  reason?: string;
  /** Completó todos los cursos pero el pedido tiene saldo pendiente (política certificates.policy). */
  blockedByBalance?: boolean;
  /** Resultado de la entrega (PDF + correo) de un certificado recién emitido. */
  delivery?: { pdf: boolean; emailed: boolean; error?: string };
}

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // sin 0/O/1/I
export function generateCertificateCode(): string {
  const bytes = crypto.randomBytes(10);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `CEIUM-${chars.slice(0, 5)}-${chars.slice(5, 10)}`;
}

export async function checkDiplomaCompletion(d: Deps, customerId: string, diplomaId: string): Promise<CompletionCheck> {
  const base = { customerId, diplomaId, total: 0, completed: 0, pendingCourseIds: [] as number[], issued: false, alreadyIssued: false };
  const existing = await d.db.certificate.findUnique({ where: { customerId_diplomaId: { customerId, diplomaId } } });
  if (existing) {
    // Recuperable: si la emisión quedó a medias (sin PDF o sin correo), se completa ahora.
    if (existing.status === "ISSUED" && (!existing.pdfPath || !existing.emailedAt)) await deliverCertificate(d, existing.id);
    return { ...base, issued: existing.status === "ISSUED", alreadyIssued: true, certificateId: existing.id, code: existing.code, reason: existing.status === "REVOKED" ? "Certificado revocado" : undefined };
  }

  const diploma = await d.db.product.findUnique({ where: { id: diplomaId }, include: { diplomaCourses: { orderBy: { position: "asc" }, include: { course: true } } } });
  if (!diploma || diploma.type !== "DIPLOMA") throw new DomainError("NOT_FOUND", "El diplomado no existe.");
  const courses = diploma.diplomaCourses.map((dc) => dc.course);
  if (courses.length === 0) return { ...base, reason: "El diplomado no tiene cursos configurados" };
  if (courses.some((c) => c.moodleCourseId == null)) return { ...base, total: courses.length, reason: "Hay cursos sin curso de Moodle asociado" };

  const purchases = await d.db.orderItem.findMany({
    where: { productId: diplomaId, order: { customerId, status: "ENROLLED" } },
    include: { order: { select: { id: true, balanceCents: true } } },
    orderBy: { order: { createdAt: "asc" } },
  });
  if (purchases.length === 0) return { ...base, total: courses.length, reason: "El cliente no tiene una inscripción vigente en el diplomado" };
  // Si hay varias compras vigentes, se prefiere la que no tiene saldo pendiente.
  const purchase = purchases.find((p) => p.order.balanceCents <= 0) ?? purchases[0];

  const customer = await d.db.customer.findUniqueOrThrow({ where: { id: customerId } });
  const now = d.now();
  let completed = 0;
  const pending: number[] = [];
  /** Filas contadas por la caché (completedAt) y no por una consulta a Moodle en esta pasada. */
  const fromCache: { id: string; moodleCourseId: number }[] = [];
  const askMoodle = async (userId: number, mid: number): Promise<boolean> => {
    try {
      return (await d.moodle.getCompletion(userId, mid)).completed === true;
    } catch (e) {
      d.log.warn(`[certificates] no se pudo consultar finalización (user ${userId}, curso ${mid})`, e);
      return false;
    }
  };
  for (const c of courses) {
    const mid = c.moodleCourseId!;
    const enr = await d.db.enrollment.findUnique({ where: { customerId_moodleCourseId: { customerId, moodleCourseId: mid } } });
    // Solo cuenta una matrícula vigente: una finalización registrada en una matrícula que luego se dio de
    // baja (reembolso, cambio de cohorte) es obsoleta y no se combina con las demás.
    if (!enr || enr.status !== "ENROLLED" || customer.moodleUserId == null) {
      pending.push(mid);
      continue;
    }
    // La caché solo vale dentro del ciclo de matrícula actual (completedAt posterior a enrolledAt). Aun así,
    // antes de emitir se vuelve a preguntar a Moodle (abajo): la caché nunca basta para certificar.
    if (enr.completedAt && enr.enrolledAt && enr.completedAt >= enr.enrolledAt) {
      completed++;
      fromCache.push({ id: enr.id, moodleCourseId: mid });
      continue;
    }
    const done = await askMoodle(customer.moodleUserId, mid);
    await d.db.enrollment.update({ where: { id: enr.id }, data: { completionCheckedAt: now, completedAt: done ? now : null } });
    if (done) completed++;
    else pending.push(mid);
  }

  const result: CompletionCheck = { ...base, total: courses.length, completed, pendingCourseIds: pending };
  if (completed < courses.length) return result;

  // Todos completos. Requisito obligatorio: saldo 0 (no configurable).
  if (purchase.order.balanceCents > 0) {
    return { ...result, blockedByBalance: true, reason: `Completó todos los cursos, pero el pedido tiene saldo pendiente (${formatUSD(purchase.order.balanceCents)}). Se emitirá al cancelar el saldo.` };
  }

  // «Nunca antes»: lo cacheado se confirma otra vez con Moodle justo antes de emitir. Si Moodle ya no lo
  // reporta completado (curso reiniciado, error), se borra la caché y no se emite.
  const regressed: number[] = [];
  for (const r of fromCache) {
    const done = await askMoodle(customer.moodleUserId!, r.moodleCourseId);
    await d.db.enrollment.update({ where: { id: r.id }, data: { completionCheckedAt: now, ...(done ? {} : { completedAt: null }) } });
    if (!done) regressed.push(r.moodleCourseId);
  }
  if (regressed.length) {
    return { ...result, completed: completed - regressed.length, pendingCourseIds: [...pending, ...regressed], reason: "Moodle no confirma la finalización de todos los cursos" };
  }

  // Emitir: certificado + evento en UNA transacción; el PDF y el correo se entregan después (recuperable).
  let cert;
  for (let i = 0; ; i++) {
    try {
      cert = await withTx(d, async (tx) => {
        const c = await tx.certificate.create({ data: { customerId, diplomaId, orderItemId: purchase.id, code: generateCertificateCode(), status: "ISSUED", issuedAt: now } });
        await addOrderEvent(tx, purchase.orderId, "CERTIFICATE_ISSUED", SYSTEM, `Certificado ${c.code}`, { certificateId: c.id });
        return c;
      });
      break;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const dup = await d.db.certificate.findUnique({ where: { customerId_diplomaId: { customerId, diplomaId } } });
      if (dup) return { ...result, issued: dup.status === "ISSUED", alreadyIssued: true, certificateId: dup.id, code: dup.code };
      if (i >= 3) throw e; // colisión de código improbable: reintentar con otro
    }
  }

  const delivery = await deliverCertificate(d, cert.id);
  return { ...result, issued: true, certificateId: cert.id, code: cert.code, delivery };
}

/**
 * Genera el PDF (si falta) y envía el correo con el PDF adjunto (si no se envió). Idempotente y
 * reintentable: el barrido de certificados la vuelve a llamar mientras falte algo.
 */
export async function deliverCertificate(d: Deps, certificateId: string): Promise<{ pdf: boolean; emailed: boolean; error?: string }> {
  const cert = await d.db.certificate.findUniqueOrThrow({
    where: { id: certificateId },
    include: { customer: true, orderItem: { select: { orderId: true } }, diploma: { include: { diplomaCourses: { orderBy: { position: "asc" }, include: { course: true } } } } },
  });
  if (cert.status !== "ISSUED") return { pdf: !!cert.pdfPath, emailed: !!cert.emailedAt };
  const orderId = cert.orderItem?.orderId ?? null;
  const fullName = `${cert.customer.firstName} ${cert.customer.lastName}`;

  let pdfPath = cert.pdfPath;
  const pdfExists = pdfPath ? await fs.stat(path.resolve(/*turbopackIgnore: true*/ pdfPath)).then(() => true, () => false) : false;
  if (!pdfPath || !pdfExists) {
    try {
      pdfPath = await writeCertificatePdf(d, {
        code: cert.code,
        fullName,
        diplomaTitle: cert.diploma.title,
        courses: cert.diploma.diplomaCourses.map((dc) => dc.course.title),
        issuedAt: cert.issuedAt,
        verifyUrl: verifyUrl(d, cert.code),
        endorsement: cert.diploma.endorsementTitle,
      });
      await d.db.certificate.update({ where: { id: cert.id }, data: { pdfPath } });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      d.log.error(`[certificates] no se pudo generar el PDF de ${cert.code}; se reintentará`, e);
      if (orderId) await d.db.$transaction((tx) => addOrderEvent(tx, orderId, "ATTENTION", SYSTEM, `No se pudo generar el PDF del certificado ${cert.code}: ${msg}. Se reintentará automáticamente.`, { certificateId: cert.id }));
      return { pdf: false, emailed: false, error: msg };
    }
  }

  if (cert.emailedAt) return { pdf: true, emailed: true };
  let emailed = false;
  await safeNotify(d, "certificate_issued", async () => {
    const rendered = T.certificateIssued({ firstName: cert.customer.firstName, fullName, diplomaTitle: cert.diploma.title, code: cert.code, verifyUrl: verifyUrl(d, cert.code), issuedAt: cert.issuedAt });
    const r = await sendEmail(d, {
      template: "certificate_issued",
      to: cert.customer.email,
      rendered,
      dedupeKey: `certificate:${cert.id}`,
      orderId,
      customerId: cert.customerId,
      attachments: [{ filename: `Certificado-${cert.code}.pdf`, path: path.resolve(/*turbopackIgnore: true*/ pdfPath!), contentType: "application/pdf" }],
    });
    // Un intento anterior falló (fila FAILED deduplicada): reintentar esa misma fila (con su PDF adjunto).
    const status = r.duplicate && r.status !== "SENT" ? await deliverOutboxEmail(d, r.id) : r.status;
    if (status === "SENT") {
      await d.db.certificate.update({ where: { id: cert.id }, data: { emailedAt: d.now() } });
      emailed = true;
    }
  });
  return { pdf: true, emailed };
}

export function verifyUrl(d: Pick<Deps, "config">, code: string) {
  return `${d.config.appUrl}/certificados/${encodeURIComponent(code)}`;
}

/** Verificación pública por código. */
export async function verifyCertificate(d: Pick<Deps, "db">, code: string) {
  const c = await d.db.certificate.findUnique({ where: { code: code.trim().toUpperCase() }, include: { customer: true, diploma: true } });
  if (!c) return null;
  return {
    code: c.code,
    status: c.status,
    holder: `${c.customer.firstName} ${c.customer.lastName}`,
    diploma: c.diploma.title,
    issuedAt: c.issuedAt,
    revokedAt: c.revokedAt,
    revokeReason: c.revokeReason,
  };
}

/** Revocación desde el panel: queda en el historial del pedido quién, cuándo y por qué. */
export async function revokeCertificate(d: Deps, actor: SessionUser, certificateId: string, reason: string) {
  const { id: adminId } = await requireAdmin(d.db, actor, "certificates.revoke");
  if (!reason?.trim()) throw new DomainError("VALIDATION", "Indica el motivo de la revocación.");
  const now = d.now();
  return withTx(d, async (tx) => {
    const cert = await tx.certificate.findUnique({ where: { id: certificateId }, include: { orderItem: { select: { orderId: true } } } });
    if (!cert) throw new DomainError("NOT_FOUND", "El certificado no existe.");
    const n = await tx.certificate.updateMany({ where: { id: certificateId, status: "ISSUED" }, data: { status: "REVOKED", revokedAt: now, revokeReason: reason.trim() } });
    if (n.count !== 1) throw new DomainError("INVALID_STATE", "El certificado ya está revocado.");
    if (cert.orderItem) {
      await addOrderEvent(tx, cert.orderItem.orderId, "CERTIFICATE_REVOKED", { type: "ADMIN", id: adminId }, reason.trim(), { certificateId, code: cert.code, revokedAt: now.toISOString() });
    }
    return tx.certificate.findUniqueOrThrow({ where: { id: certificateId } });
  });
}

/**
 * Job: (1) completa entregas a medias (PDF o correo pendientes) y (2) revisa a todos los inscritos en
 * diplomados sin certificado y emite los que correspondan.
 */
export async function runCertificateSweep(d: Deps): Promise<{ checked: number; issued: number; codes: string[]; redelivered: number }> {
  let redelivered = 0;
  const incomplete = await d.db.certificate.findMany({ where: { status: "ISSUED", OR: [{ pdfPath: null }, { emailedAt: null }] }, select: { id: true } });
  for (const c of incomplete) {
    try {
      const r = await deliverCertificate(d, c.id);
      if (r.pdf && r.emailed) redelivered++;
    } catch (e) {
      d.log.error(`[certificates] fallo reentregando ${c.id}`, e);
    }
  }

  const items = await d.db.orderItem.findMany({
    where: { productType: "DIPLOMA", order: { status: "ENROLLED" } },
    select: { productId: true, order: { select: { customerId: true } } },
  });
  const pairs = new Map<string, { customerId: string; diplomaId: string }>();
  for (const it of items) pairs.set(`${it.order.customerId}:${it.productId}`, { customerId: it.order.customerId, diplomaId: it.productId });
  const existing = await d.db.certificate.findMany({ select: { customerId: true, diplomaId: true } });
  for (const c of existing) pairs.delete(`${c.customerId}:${c.diplomaId}`);

  let issued = 0;
  const codes: string[] = [];
  for (const { customerId, diplomaId } of pairs.values()) {
    try {
      const r = await checkDiplomaCompletion(d, customerId, diplomaId);
      if (r.issued && !r.alreadyIssued) {
        issued++;
        codes.push(r.code!);
      }
    } catch (e) {
      d.log.error(`[certificates] fallo revisando ${customerId}/${diplomaId}`, e);
    }
  }
  return { checked: pairs.size, issued, codes, redelivered };
}

// ───────────── PDF ─────────────

export interface CertificatePdfData {
  code: string;
  fullName: string;
  diplomaTitle: string;
  courses: string[];
  issuedAt: Date;
  verifyUrl: string;
  endorsement?: string | null;
}

/** Las fuentes estándar usan WinAnsi: se eliminan caracteres fuera de Latin-1 (emojis, etc.). */
const winAnsi = (s: string) => s.normalize("NFC").replace(/[^\x20-\x7E\xA0-\xFF]/g, "").trim();

export async function renderCertificatePdf(c: CertificatePdfData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Certificado ${c.code}`);
  pdf.setAuthor("CEIUM");
  pdf.setSubject(winAnsi(c.diplomaTitle));
  const page = pdf.addPage([841.89, 595.28]); // A4 horizontal
  const { width, height } = page.getSize();
  const serif = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const serifItalic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const sansBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0, 30 / 255, 43 / 255);
  const teal = rgb(9 / 255, 176 / 255, 176 / 255);
  const muted = rgb(0.36, 0.42, 0.45);

  page.drawRectangle({ x: 24, y: 24, width: width - 48, height: height - 48, borderColor: ink, borderWidth: 2 });
  page.drawRectangle({ x: 32, y: 32, width: width - 64, height: height - 64, borderColor: teal, borderWidth: 0.8 });

  const center = (text: string, y: number, font = sans, size = 12, color = ink) => {
    const t = winAnsi(text);
    const w = font.widthOfTextAtSize(t, size);
    page.drawText(t, { x: (width - w) / 2, y, size, font, color });
  };
  const wrap = (text: string, font: typeof sans, size: number, maxWidth: number): string[] => {
    const words = winAnsi(text).split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > maxWidth && cur) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  };

  center("CEIUM", height - 90, sansBold, 30, ink);
  center("Centro de Enseñanza e Investigación de Ultrasonido en Medicina", height - 110, sans, 11, muted);
  center("CERTIFICADO", height - 165, serif, 34, teal);
  center("Se otorga el presente certificado a", height - 200, serifItalic, 15, ink);
  center(c.fullName, height - 245, serif, 30, ink);
  page.drawLine({ start: { x: width / 2 - 220, y: height - 255 }, end: { x: width / 2 + 220, y: height - 255 }, thickness: 0.8, color: teal });
  center("por haber completado satisfactoriamente todos los cursos del", height - 285, serifItalic, 14, ink);
  let y = height - 318;
  for (const line of wrap(c.diplomaTitle, serif, 20, width - 200)) {
    center(line, y, serif, 20, ink);
    y -= 24;
  }
  if (c.endorsement) {
    center(c.endorsement, y - 4, sans, 11, muted);
    y -= 22;
  }
  const courseLine = `${c.courses.length} cursos: ${c.courses.join(" · ")}`;
  for (const line of wrap(courseLine, sans, 8.5, width - 160).slice(0, 4)) {
    center(line, y - 8, sans, 8.5, muted);
    y -= 12;
  }

  const dateText = `Emitido el ${T.formatDate(c.issuedAt)}`;
  page.drawText(winAnsi(dateText), { x: 70, y: 70, size: 10, font: sans, color: ink });
  page.drawText(winAnsi(`Código de verificación: ${c.code}`), { x: 70, y: 55, size: 10, font: sansBold, color: ink });
  const vt = winAnsi(`Verifica en ${c.verifyUrl}`);
  page.drawText(vt, { x: width - 70 - sans.widthOfTextAtSize(vt, 9), y: 55, size: 9, font: sans, color: muted });
  return pdf.save();
}

async function writeCertificatePdf(d: Deps, c: CertificatePdfData): Promise<string> {
  const bytes = await renderCertificatePdf(c);
  const rel = path.join(d.config.certificatesDir, `${c.code}.pdf`);
  await fs.mkdir(path.dirname(path.resolve(/*turbopackIgnore: true*/ rel)), { recursive: true });
  await fs.writeFile(path.resolve(/*turbopackIgnore: true*/ rel), bytes);
  return rel;
}
