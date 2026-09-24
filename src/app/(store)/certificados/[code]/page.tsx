// Verificación pública de un certificado (/certificados/[code]). Es la URL impresa en el PDF del certificado
// y enviada en su correo (certificates.verifyUrl).
import type { Metadata } from "next";
import Link from "next/link";
import { services } from "@/server/services";
import { formatDate } from "@/server/email/templates";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Verificar certificado", robots: { index: false, follow: false } };

const box: React.CSSProperties = { maxWidth: 560, margin: "48px auto", padding: "32px 24px", border: "1px solid rgba(0,30,43,0.12)", borderRadius: 12, background: "#fff" };
const h1: React.CSSProperties = { color: "var(--ink)", fontSize: 24, lineHeight: 1.25, margin: "0 0 12px" };
const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 16, padding: "8px 0", borderBottom: "1px solid rgba(0,30,43,0.08)" };

export default async function VerifyCertificatePage({ params }: PageProps<"/certificados/[code]">) {
  const { code } = await params;
  const cert = await services().certificates.verifyCertificate(decodeURIComponent(code));
  const valid = cert?.status === "ISSUED";
  return (
    <main style={{ padding: "0 16px" }}>
      <section style={box}>
        {!cert ? (
          <>
            <h1 style={h1}>Certificado no encontrado</h1>
            <p>
              No existe un certificado con el código <strong>{decodeURIComponent(code)}</strong>. Revisa que el código esté completo (formato CEIUM-XXXXX-XXXXX).
            </p>
          </>
        ) : (
          <>
            <p role="status" style={{ display: "inline-block", margin: "0 0 12px", padding: "4px 10px", borderRadius: 999, fontSize: 14, fontWeight: 600, background: valid ? "#e6f7f7" : "#fdecec", color: valid ? "#067a7a" : "#b3261e" }}>
              {valid ? "Certificado válido" : "Certificado revocado"}
            </p>
            <h1 style={h1}>{cert.diploma}</h1>
            <div style={row}>
              <span>Otorgado a</span>
              <strong style={{ color: "var(--ink)", textAlign: "right" }}>{cert.holder}</strong>
            </div>
            <div style={row}>
              <span>Código</span>
              <span>{cert.code}</span>
            </div>
            <div style={row}>
              <span>Emitido</span>
              <span>{formatDate(cert.issuedAt)}</span>
            </div>
            {!valid && cert.revokedAt ? (
              <div style={row}>
                <span>Revocado</span>
                <span>{formatDate(cert.revokedAt)}</span>
              </div>
            ) : null}
            {valid && cert.courses.length ? (
              <>
                <p style={{ margin: "16px 0 4px", color: "var(--ink)", fontWeight: 600 }}>Cursos aprobados</p>
                <ol style={{ margin: 0, paddingLeft: 20 }}>
                  {cert.courses.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ol>
              </>
            ) : null}
          </>
        )}
        <p style={{ marginTop: 24, fontSize: 14 }}>
          <Link href="/" style={{ color: "var(--teal)" }}>
            Ir a CEIUM
          </Link>
        </p>
      </section>
    </main>
  );
}
