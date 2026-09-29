// Datos del médico en páginas públicas del pedido (/checkout y /pedido/<token>): el enlace es la única credencial
// y el pedido puede estar a nombre de un correo existente (checkout sin cuenta), así que cédula y teléfono se
// muestran parcialmente, como hacen los bancos. El correo sí completo (quien tiene el enlace ya lo conoce).

/** «V-12345678» → «V-•••••678». */
export function maskCedula(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^([A-Za-z]-?)?(.*)$/.exec(v.trim())!;
  const digits = m[2].replace(/\D/g, "");
  if (digits.length <= 3) return v;
  return `${m[1] ?? ""}${"•".repeat(Math.max(3, digits.length - 3))}${digits.slice(-3)}`;
}

/** «0414-1234567» → «0414-•••••67». */
export function maskPhone(v: string | null | undefined): string | null {
  if (!v) return null;
  const digits = v.replace(/\D/g, "");
  if (digits.length < 7) return v;
  return `${digits.slice(0, 4)}-${"•".repeat(digits.length - 6)}${digits.slice(-2)}`;
}
