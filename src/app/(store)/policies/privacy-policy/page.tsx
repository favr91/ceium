// Política de privacidad (enlace del pie). Texto en la Setting `store.privacyPolicy` = { html, updatedAt? };
// mientras no se cargue, se muestra cómo contactar a CEIUM (el texto de ceium.net describe la tienda Shopify
// anterior y no aplica tal cual a este sistema).
import type { Metadata } from "next";
import { connection } from "next/server";
import { prisma } from "@/server/db";
import { SETTING_KEYS } from "@/server/settings";

export const metadata: Metadata = { title: "Política de privacidad" };
const PRIVACY_SETTING_KEY = "store.privacyPolicy";

export default async function PrivacyPolicyPage() {
  await connection();
  const [policy, contact] = await Promise.all([
    prisma.setting.findUnique({ where: { key: PRIVACY_SETTING_KEY } }),
    prisma.setting.findUnique({ where: { key: SETTING_KEYS.storeContact } }),
  ]);
  const value = (policy?.value ?? null) as { html?: string; updatedAt?: string } | null;
  const emails = ((contact?.value ?? {}) as { emails?: string[] }).emails ?? [];
  return (
    <div className="shopify-policy page-width">
      <h1 className="shopify-policy__title">Política de privacidad</h1>
      {value?.html ? (
        <div className="rte" dangerouslySetInnerHTML={{ __html: value.html }} />
      ) : (
        <div className="rte">
          <p>
            CEIUM usa los datos que nos das al inscribirte (nombre, correo, teléfono y datos de pago) solo para gestionar tu inscripción, tu acceso a la
            plataforma de cursos y tus certificados. Los pagos con PayPal se procesan en PayPal; no guardamos datos de tarjetas.
          </p>
          {emails.length ? (
            <p>
              Para consultar, corregir o eliminar tus datos, escríbenos a{" "}
              {emails.map((e, i) => (
                <span key={e}>
                  {i > 0 ? " o " : ""}
                  <a href={`mailto:${e}`}>{e}</a>
                </span>
              ))}
              .
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
