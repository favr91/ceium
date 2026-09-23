// Transportes de correo (nodemailer).
//  - outbox: genera el .eml (stream transport) y lo guarda en MAIL_DIR; la fila EmailOutbox es la bandeja.
//  - smtp:   envía por SMTP real y además guarda el .eml.
import fs from "node:fs/promises";
import path from "node:path";
import nodemailer from "nodemailer";

export interface MailAttachment {
  filename: string;
  path?: string;
  content?: Buffer | string;
  contentType?: string;
}

export interface MailMessage {
  /** id de la fila EmailOutbox (nombra el .eml) */
  id: string;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: MailAttachment[];
}

export interface MailResult {
  messageId?: string;
  emlPath?: string;
}

export interface Mailer {
  readonly kind: string;
  send(msg: MailMessage): Promise<MailResult>;
}

async function buildEml(msg: MailMessage): Promise<Buffer> {
  const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const info = await t.sendMail(toNodemailer(msg));
  return info.message as Buffer;
}

function toNodemailer(msg: MailMessage) {
  return { from: msg.from, to: msg.to, cc: msg.cc, bcc: msg.bcc, subject: msg.subject, html: msg.html, text: msg.text, attachments: msg.attachments };
}

async function writeEml(dir: string, id: string, eml: Buffer): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.eml`);
  await fs.writeFile(file, eml);
  return file;
}

export function createOutboxMailer(mailDir: string): Mailer {
  return {
    kind: "outbox",
    async send(msg) {
      const eml = await buildEml(msg);
      const emlPath = await writeEml(mailDir, msg.id, eml);
      return { messageId: `<${msg.id}@outbox.ceium.local>`, emlPath };
    },
  };
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
}

export function createSmtpMailer(opts: SmtpOptions, mailDir?: string): Mailer {
  const transport = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
  });
  return {
    kind: "smtp",
    async send(msg) {
      const info = await transport.sendMail(toNodemailer(msg));
      let emlPath: string | undefined;
      if (mailDir) {
        try {
          emlPath = await writeEml(mailDir, msg.id, await buildEml(msg));
        } catch {
          /* la copia local es opcional */
        }
      }
      return { messageId: info.messageId, emlPath };
    },
  };
}

export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  const dir = env.MAIL_DIR ?? "var/mail";
  if ((env.MAIL_TRANSPORT ?? "outbox") === "smtp" && env.SMTP_HOST) {
    return createSmtpMailer(
      { host: env.SMTP_HOST, port: Number(env.SMTP_PORT ?? 587), secure: env.SMTP_SECURE === "true", user: env.SMTP_USER || undefined, pass: env.SMTP_PASS || undefined },
      dir,
    );
  }
  return createOutboxMailer(dir);
}
