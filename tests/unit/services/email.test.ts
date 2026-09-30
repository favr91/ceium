import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retryFailedEmails, sendEmail } from "@/server/email";
import * as T from "@/server/email/templates";
import type { Mailer } from "@/server/email/mailer";
import { setupContext, type TestContext } from "./helpers/setup";

const view: T.OrderView = {
  number: 1001,
  statusUrl: "https://ceium.test/pedido/abc",
  customerFirstName: "Ana <script>",
  customerEmail: "ana@example.com",
  items: [{ title: "Diplomado Universitario Avanzado de Medicina Materno-Fetal", modalityLabel: "Semipresencial — Barquisimeto", planLabel: "Paga la mitad (5 % de descuento)", cohortName: "Cohorte II - 2026", totalCents: 134900, dueNowCents: 67450 }],
  totalCents: 134900,
  dueNowCents: 67450,
  amountPaidCents: 67450,
  balanceCents: 67450,
};

describe("plantillas", () => {
  it("renderizan en español, con montos formateados y datos escapados", () => {
    const all = [
      T.orderConfirmation(view, { paid: true }),
      T.paymentUnderVerification(view, { methodLabel: "Pago móvil", amountLabel: "Bs. 67.450,00 (≈ $674.50)", reference: "0012" }),
      T.paymentApproved(view, { methodLabel: "Pago móvil", amountLabel: "$674.50" }),
      T.paymentRejected(view, { methodLabel: "Pago móvil", amountLabel: "$674.50" }, "Referencia inválida", true),
      T.platformAccess({ firstName: "Ana", username: "ana@example.com", loginUrl: "https://aula.ceium.test", tempPassword: "Tmp#1", courses: ["Curso 1"] }),
      T.cohortDetails({ firstName: "Ana", productTitle: "Diplomado", cohortName: "Cohorte II - 2026", sedeName: "Barquisimeto", sedeAddress: "Av. Andrés Bello", startDate: new Date("2026-10-03T12:00:00Z"), endDate: new Date("2027-06-30T12:00:00Z"), sessions: [{ date: "2026-10-03", title: "Práctica" }], orderNumber: 1001 }),
      T.certificateIssued({ firstName: "Ana", fullName: "Ana Pérez", diplomaTitle: "Diplomado X", code: "CEIUM-AAAAA-BBBBB", verifyUrl: "https://ceium.test/certificados/CEIUM-AAAAA-BBBBB", issuedAt: new Date() }),
      T.refundIssued(view, { amountCents: 67450, methodLabel: "PayPal", reason: "Retiro", full: true }),
    ];
    for (const e of all) {
      expect(e.subject.length).toBeGreaterThan(5);
      expect(e.html).toContain('lang="es"');
      expect(e.html).not.toContain("<script>");
      expect(e.text.length).toBeGreaterThan(20);
    }
    expect(all[0].html).toContain("$1,349.00");
    expect(all[0].html).toContain("Saldo pendiente");
    expect(all[0].html).toContain("Ana &lt;script&gt;");
    expect(all[3].html).toContain("Referencia inválida");
    expect(all[5].text).toContain("3 de octubre de 2026");
    expect(all[4].text).toContain("Contraseña temporal: Tmp#1");
  });
});

describe("outbox", () => {
  let ctx: TestContext;
  let failing = 1;
  const flaky: Mailer = {
    kind: "flaky",
    async send(msg) {
      if (failing-- > 0) throw new Error("SMTP 421");
      return { messageId: msg.id };
    },
  };
  beforeEach(async () => {
    failing = 0;
    ctx = await setupContext("email");
  });
  afterEach(async () => {
    await ctx.dispose();
  });

  it("guarda en EmailOutbox, escribe .eml y deduplica por dedupeKey", async () => {
    const rendered = T.paymentApproved(view, { methodLabel: "PayPal", amountLabel: "$674.50" });
    const a = await sendEmail(ctx.d, { template: "payment_approved", to: "ana@example.com", rendered, dedupeKey: "k1" });
    const b = await sendEmail(ctx.d, { template: "payment_approved", to: "ana@example.com", rendered, dedupeKey: "k1" });
    expect(a).toMatchObject({ status: "SENT", duplicate: false });
    expect(b).toMatchObject({ id: a.id, duplicate: true });
    const row = await ctx.db.emailOutbox.findUniqueOrThrow({ where: { id: a.id } });
    const eml = fs.readFileSync(row.emlPath!, "utf8");
    expect(eml).toMatch(/Subject: =\?UTF-8\?/);
    expect(eml).toContain("To: ana@example.com");
    expect(await ctx.db.emailOutbox.count()).toBe(1);
  });

  it("un fallo de envío queda FAILED y el job lo reintenta", async () => {
    const d = { ...ctx.d, mailer: flaky };
    failing = 1;
    const r = await sendEmail(d, { template: "payment_approved", to: "x@example.com", rendered: T.paymentApproved(view, { methodLabel: "PayPal", amountLabel: "$1" }) });
    expect(r.status).toBe("FAILED");
    expect((await ctx.db.emailOutbox.findUniqueOrThrow({ where: { id: r.id } })).lastError).toContain("SMTP 421");
    expect(await retryFailedEmails(d)).toBe(1);
    expect((await ctx.db.emailOutbox.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("SENT");
  });
});
