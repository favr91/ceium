// Quita la verificación en dos pasos de un usuario del panel que perdió el teléfono Y sus códigos de recuperación
// (y lo desbloquea). Se corre en el servidor, con acceso a la BD; queda en la auditoría. Al entrar con su
// contraseña, el usuario la vuelve a configurar (obligatorio si Configuración la exige).
//   npm run admin:reset-2fa -- correo@ceium.net
import "dotenv/config";
import { resetTwoFactorFor } from "../src/server/admin-account";
import { services } from "../src/server/services";

async function main() {
  const email = (process.argv[2] ?? "").trim().toLowerCase();
  if (!email) {
    console.error("Uso: npm run admin:reset-2fa -- correo@ceium.net");
    process.exit(1);
  }
  const d = services().deps;
  const u = await d.db.adminUser.findUnique({ where: { email }, select: { id: true, name: true, totpEnabledAt: true } });
  if (!u) {
    console.error(`No existe un usuario del panel con el correo ${email}.`);
    process.exit(1);
  }
  await resetTwoFactorFor(d, null, u.id, "Restablecida desde el servidor (scripts/admin-reset-2fa.ts)");
  console.log(`Listo: ${u.name} (${email}) ya no tiene verificación en dos pasos${u.totpEnabledAt ? "" : " (no la tenía activada)"}; sus sesiones se cerraron y la cuenta quedó desbloqueada.`);
  await d.db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
