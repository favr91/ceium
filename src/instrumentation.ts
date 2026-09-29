// Al arrancar el servidor: revisa la configuración de producción (ver server/config-check.ts). Con errores no arranca
// (mejor un despliegue que falla a la vista que una tienda cobrando con PayPal de pruebas o secretos de ejemplo).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { productionConfigProblems } = await import("./server/config-check");
  const { errors, warnings } = productionConfigProblems();
  for (const w of warnings) console.warn(`[config] ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`[config] ${e}`);
    throw new Error(`Configuración de producción incompleta (${errors.length} problema${errors.length === 1 ? "" : "s"}): revisa el registro [config].`);
  }
}
