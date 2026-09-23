// Certificado de diplomado: se emite SOLO cuando Moodle reporta completados TODOS los cursos del
// diplomado (core_completion_get_course_completion_status). Nunca antes, nunca dos veces
// (única por cliente+diplomado). PDF con pdf-lib y código verificable público.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Deps } from "@/server/deps";
import { DomainError, isUniqueViolation } from "@/server/errors";
import { safeNotify, sendEmail } from "@/server/email";
import * as T from "@/server/email/templates";

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
  if (existing) return { ...base, issued: existing.status === "ISSUED", alreadyIssued: true, certificateId: existing.id, code: existing.code, reason: existing.status === "REVOKED" ? "Certificado revocado" : undefined };

  const diploma = await d.db.product.findUnique({ where: { id: diplomaId }, include: { diplomaCourses: { orderBy: { position: "asc" }, include: { course: true } } } });
  if (!diploma || diploma.type !== "DIPLOMA") throw new DomainError("NOT_FOUND", "El diplomado no existe.");
  const courses = diploma.diplomaCourses.map((dc) => dc.course);
  if (courses.length === 0) return { ...base, reason: "El diplomado no tiene cursos configurados" };
  if (courses.some((c) => c.moodleCourseId == null)) return { ...base, total: courses.length, reason: "Hay cursos sin curso de Moodle asociado" };

  const purchase = await d.db.orderItem.findFirst({
    where: { productId: diplomaId, order: { customerId, status: "ENROLLED" } },
    orderBy: { order: { createdAt: "asc" } },
  });
  if (!purchase) return { ...base, total: courses.length, reason: "El cliente no tiene una inscripción vigente en el diplomado" };

  const customer = await d.db.customer.findUniqueOrThrow({ where: { id: customerId } });
  const now = d.now();
  let completed = 0;
  const pending: number[] = [];
  for (const c of courses) {
    const mid = c.moodleCourseId!;
    const enr = await d.db.enrollment.findUnique({ where: { customerId_moodleCourseId: { customerId, moodleCourseId: mid } } });
    if (enr?.completedAt) {
      completed++;
      continue;
    }
    if (!enr || enr.status !== "ENROLLED" || customer.moodleUserId == null) {
      pending.push(mid);
      continue;
    }
    let done = false;
    try {
      done = (await d.moodle.getCompletion(customer.moodleUserId, mid)).completed === true;
    } catch (e) {
      d.log.warn(`[certificates] no se pudo consultar finalización (user ${customer.moodleUserId}, curso ${mid})`, e);
    }
    await d.db.enrollment.update({ where: { id: enr.id }, data: { completionCheckedAt: now, ...(done ? { completedAt: now } : {}) } });
    if (done) completed++;
    else pending.push(mid);
  }

  const result: CompletionCheck = { ...base, total: courses.length, completed, pendingCourseIds: pending };
  if (completed < courses.length) return result;

  // Todos completos → emitir.
  let cert;
  for (let i = 0; ; i++) {
    try {
      cert = await d.db.certificate.create({ data: { customerId, diplomaId, orderItemId: purchase.id, code: generateCertificateCode(), status: "ISSUED", issuedAt: now } });
      break;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const dup = await d.db.certificate.findUnique({ where: { customerId_diplomaId: { customerId, diplomaId } } });
      if (dup) return { ...result, issued: true, alreadyIssued: true, certificateId: dup.id, code: dup.code };
      if (i >= 3) throw e; // colisión de código improbable: reintentar con otro
    }
  }

  const pdfPath = await writeCertificatePdf(d, {
    code: cert.code,
    fullName: `${customer.firstName} ${customer.lastName}`,
    diplomaTitle: diploma.title,
    courses: courses.map((c) => c.title),
    issuedAt: now,
    verifyUrl: verifyUrl(d, cert.code),
    endorsement: diploma.endorsementTitle,
  });
  await d.db.certificate.update({ where: { id: cert.id }, data: { pdfPath } });
  await d.db.orderEvent.create({ data: { orderId: purchase.orderId, type: "CERTIFICATE_ISSUED", actorType: "SYSTEM", note: `Certificado ${cert.code}`, data: { certificateId: cert.id } } });

  await safeNotify(d, "certificate_issued", async () => {
    const rendered = T.certificateIssued({ firstName: customer.firstName, fullName: `${customer.firstName} ${customer.lastName}`, diplomaTitle: diploma.title, code: cert.code, verifyUrl: verifyUrl(d, cert.code), issuedAt: now });
    const r = await sendEmail(d, {
      template: "certificate_issued",
      to: customer.email,
      rendered,
      dedupeKey: `certificate:${cert.id}`,
      orderId: purchase.orderId,
      customerId,
      attachments: [{ filename: `Certificado-${cert.code}.pdf`, path: path.resolve(pdfPath), contentType: "application/pdf" }],
    });
    if (r.status === "SENT") await d.db.certificate.update({ where: { id: cert.id }, data: { emailedAt: d.now() } });
  });

  return { ...result, issued: true, certificateId: cert.id, code: cert.code };
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

export async function revokeCertificate(d: Deps, certificateId: string, reason: string) {
  if (!reason?.trim()) throw new DomainError("VALIDATION", "Indica el motivo de la revocación.");
  return d.db.certificate.update({ where: { id: certificateId }, data: { status: "REVOKED", revokedAt: d.now(), revokeReason: reason.trim() } });
}

/** Job: revisa a todos los clientes inscritos en diplomados sin certificado y emite los que correspondan. */
export async function runCertificateSweep(d: Deps): Promise<{ checked: number; issued: number; codes: string[] }> {
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
  return { checked: pairs.size, issued, codes };
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
  await fs.mkdir(path.dirname(path.resolve(rel)), { recursive: true });
  await fs.writeFile(path.resolve(rel), bytes);
  return rel;
}
