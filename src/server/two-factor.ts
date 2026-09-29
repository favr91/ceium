// Verificación en dos pasos del panel: códigos TOTP de 6 dígitos (RFC 6238, los de Google Authenticator,
// Microsoft Authenticator, Authy o 1Password) y códigos de recuperación de un solo uso.
//  - El secreto se guarda cifrado (AES-256-GCM; clave derivada de SESSION_SECRET con HKDF): un volcado de la BD
//    no basta para generar códigos.
//  - Ventana de ±30 s (relojes de teléfono desfasados) y un mismo código no se acepta dos veces (último paso).
//  - Los códigos de recuperación solo se guardan como sha256 y cada uno sirve una vez.
import crypto from "node:crypto";
import { DomainError } from "@/server/errors";

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
export const TOTP_ISSUER = "CEIUM";
const RECOVERY_COUNT = 10;
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // sin 0/o, 1/l/i
const DEV_SECRET = "dev-only-change-me-dev-only-change-me-000";

// ───────────── Base32 (RFC 4648, sin relleno) ─────────────

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new DomainError("VALIDATION", "Clave inválida.");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ───────────── TOTP ─────────────

export const totpStep = (now: Date) => Math.floor(now.getTime() / 1000 / TOTP_PERIOD);

/** Código de 6 dígitos para un paso de 30 s (HOTP con HMAC-SHA1, RFC 4226 §5.3). */
export function totpCode(secret: Buffer, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Paso aceptado (para guardarlo como último usado) o null. Acepta el paso actual y los vecinos (±30 s) y rechaza
 * pasos iguales o anteriores a `lastStep` (repetición del mismo código).
 */
export function verifyTotp(secret: Buffer, input: string, now: Date, lastStep?: number | null): number | null {
  const code = input.replace(/\D/g, "");
  if (code.length !== TOTP_DIGITS) return null;
  const cur = totpStep(now);
  for (const step of [cur, cur - 1, cur + 1]) {
    if (lastStep != null && step <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

export const newTotpSecret = () => crypto.randomBytes(20);

/** URI que leen las apps autenticadoras (QR). */
export function otpauthUri(email: string, secret: Buffer): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${email}`);
  const q = new URLSearchParams({ secret: base32Encode(secret), issuer: TOTP_ISSUER, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD) });
  return `otpauth://totp/${label}?${q}`;
}

/** Clave en grupos de 4 para escribirla a mano en la app. */
export const formatManualKey = (secret: Buffer) => base32Encode(secret).replace(/(.{4})/g, "$1 ").trim();

// ───────────── Cifrado del secreto ─────────────

function encryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const secret = env.SESSION_SECRET ?? "";
  const prod = env.NODE_ENV === "production";
  if (prod && (secret.length < 32 || secret === DEV_SECRET)) {
    throw new DomainError("INVALID_STATE", "Falta configurar SESSION_SECRET (32 caracteres o más, distinto del de ejemplo) para usar la verificación en dos pasos.");
  }
  return Buffer.from(crypto.hkdfSync("sha256", secret || DEV_SECRET, "ceium", "admin-totp-v1", 32));
}

/** «v1.<iv>.<tag>.<cifrado>» en base64url. */
export function sealSecret(secret: Buffer, env?: NodeJS.ProcessEnv): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  const ct = Buffer.concat([c.update(secret), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function openSecret(sealed: string, env?: NodeJS.ProcessEnv): Buffer {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new DomainError("INVALID_STATE", "Secreto de verificación dañado.");
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", encryptionKey(env), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]);
  } catch {
    // SESSION_SECRET cambió desde que se configuró: el usuario entra con un código de recuperación y la vuelve a activar.
    throw new DomainError("INVALID_STATE", "No se pudo leer la verificación en dos pasos (¿cambió SESSION_SECRET?). Usa un código de recuperación.");
  }
}

// ───────────── Códigos de recuperación ─────────────

const hashRecovery = (code: string) => crypto.createHash("sha256").update(`ceium-recovery:${code}`).digest("hex");

/** «abcde-fghjk» sin guion, espacios ni mayúsculas. */
export const normalizeRecoveryCode = (input: string) => input.toLowerCase().replace(/[^a-z0-9]/g, "");

export function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: RECOVERY_COUNT }, () => {
    const raw = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]).join("");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { codes, hashes: codes.map((c) => hashRecovery(normalizeRecoveryCode(c))) };
}

/** Lista de hashes guardada (JSON) sin el código usado, o null si el código no es válido. */
export function consumeRecoveryCode(stored: string | null, input: string): string[] | null {
  const hashes: string[] = stored ? (JSON.parse(stored) as string[]) : [];
  const h = hashRecovery(normalizeRecoveryCode(input));
  const i = hashes.findIndex((x) => x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
  if (i < 0) return null;
  return [...hashes.slice(0, i), ...hashes.slice(i + 1)];
}

export const recoveryCodesLeft = (stored: string | null) => (stored ? (JSON.parse(stored) as string[]).length : 0);
