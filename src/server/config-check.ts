// Revisión de la configuración de producción. Sin esto, una variable que faltaba caía en silencio en el valor de
// desarrollo: correos «enviados» que nunca salían (outbox), PayPal de pruebas, enlaces a http://localhost en los
// correos y en PayPal, secretos de ejemplo. Errores = el servidor no arranca; avisos = se muestran en el panel.

export interface ConfigProblems {
  errors: string[];
  warnings: string[];
}

const DEV_SESSION_SECRET = "dev-only-change-me-dev-only-change-me-000";
const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url);

/** Solo aplica a un despliegue real (NODE_ENV=production con APP_URL que no es localhost). */
export function productionConfigProblems(env: NodeJS.ProcessEnv = process.env): ConfigProblems {
  const errors: string[] = [];
  const warnings: string[] = [];
  const appUrl = env.APP_URL ?? "";
  if (env.NODE_ENV !== "production" || (appUrl && isLocal(appUrl))) return { errors, warnings };

  if (!appUrl) errors.push("Falta APP_URL (la dirección pública de la tienda, p. ej. https://ceium.net): los correos y PayPal usarían http://localhost.");
  else if (!appUrl.startsWith("https://")) errors.push("APP_URL debe empezar por https:// (las cookies del panel y del pedido viajan cifradas).");
  const secret = env.SESSION_SECRET ?? "";
  if (secret.length < 32 || secret === DEV_SESSION_SECRET) errors.push("SESSION_SECRET debe tener 32 caracteres o más y no ser el de ejemplo (cifra la verificación en dos pasos).");
  if (env.CRON_SECRET && (env.CRON_SECRET.length < 24 || env.CRON_SECRET === "dev-cron-secret")) errors.push("CRON_SECRET debe tener 24 caracteres o más y no ser el de ejemplo.");
  if (!env.PAYPAL_BASE_URL) errors.push("Falta PAYPAL_BASE_URL (https://api-m.paypal.com en producción): sin ella se usaría el PayPal de pruebas.");
  else if (isLocal(env.PAYPAL_BASE_URL)) errors.push("PAYPAL_BASE_URL apunta al simulador local.");
  else if (/sandbox/.test(env.PAYPAL_BASE_URL)) warnings.push("PayPal está en modo de pruebas (sandbox): los pagos no son reales.");
  if (!env.PAYPAL_WEBHOOK_ID || /^mock/.test(env.PAYPAL_WEBHOOK_ID)) errors.push("Falta PAYPAL_WEBHOOK_ID real (sin él no se confirman los pagos por webhook).");
  if (env.MOODLE_URL && isLocal(env.MOODLE_URL)) errors.push("MOODLE_URL apunta al simulador local.");
  if (!env.MOODLE_URL || !env.MOODLE_TOKEN) warnings.push("Falta MOODLE_URL o MOODLE_TOKEN: no se puede matricular en el aula virtual.");
  if ((env.MAIL_TRANSPORT ?? "outbox") !== "smtp" || !env.SMTP_HOST) warnings.push("El correo no está configurado (MAIL_TRANSPORT=smtp y SMTP_HOST): los correos se guardan pero NO se envían a nadie.");
  return { errors, warnings };
}
