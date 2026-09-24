// Íconos del tema Dawn (ceium.net) y marca de PayPal para el botón del carrito/checkout.
export function MinusIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 10 2" aria-hidden="true" focusable="false">
      <path fill="currentColor" fillRule="evenodd" d="M.5 1C.5.7.7.5 1 .5h8a.5.5 0 1 1 0 1H1A.5.5 0 0 1 .5 1" clipRule="evenodd" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path fill="currentColor" fillRule="evenodd" d="M1 4.51a.5.5 0 0 0 0 1h3.5l.01 3.5a.5.5 0 0 0 1-.01V5.5l3.5-.01a.5.5 0 0 0-.01-1H5.5L5.49.99a.5.5 0 0 0-1 .01v3.5l-3.5.01z" clipRule="evenodd" />
    </svg>
  );
}

export function RemoveIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M14 3h-3.53a3.07 3.07 0 0 0-.6-1.65C9.44.82 8.8.5 8 .5s-1.44.32-1.87.85A3.06 3.06 0 0 0 5.53 3H2a.5.5 0 0 0 0 1h1.25v10c0 .28.22.5.5.5h8.5a.5.5 0 0 0 .5-.5V4H14a.5.5 0 0 0 0-1M6.91 1.98c.23-.29.58-.48 1.09-.48s.85.19 1.09.48c.2.24.3.6.36 1.02h-2.9c.05-.42.17-.78.36-1.02m4.84 11.52h-7.5V4h7.5z" />
      <path fill="currentColor" d="M6.55 5.25a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 1 0v-6a.5.5 0 0 0-.5-.5m2.9 0a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 1 0v-6a.5.5 0 0 0-.5-.5" />
    </svg>
  );
}

export function ErrorIcon() {
  return (
    <svg viewBox="0 0 13 13" aria-hidden="true" focusable="false">
      <circle cx="6.5" cy="6.5" r="5.5" stroke="#fff" strokeWidth="2" />
      <circle cx="6.5" cy="6.5" r="5.5" fill="#EB001B" stroke="#EB001B" strokeWidth=".7" />
      <path fill="#fff" d="m5.874 3.528.1 4.044h1.053l.1-4.044zm.627 6.133c.38 0 .68-.288.68-.656s-.3-.656-.68-.656-.681.288-.681.656.3.656.68.656" />
    </svg>
  );
}

/** Logotipo «PayPal» (azul) del botón inteligente de PayPal. */
export function PayPalWordmark() {
  return (
    <svg viewBox="0 0 101 32" preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <path fill="#003087" d="M 12.237 2.8 L 4.437 2.8 C 3.937 2.8 3.437 3.2 3.337 3.7 L 0.237 23.7 C 0.137 24.1 0.437 24.4 0.837 24.4 L 4.537 24.4 C 5.037 24.4 5.537 24 5.637 23.5 L 6.437 18.1 C 6.537 17.6 6.937 17.2 7.537 17.2 L 10.037 17.2 C 15.137 17.2 18.137 14.7 18.937 9.8 C 19.237 7.7 18.937 6 17.937 4.8 C 16.837 3.5 14.837 2.8 12.237 2.8 Z M 13.137 10.1 C 12.737 12.9 10.537 12.9 8.537 12.9 L 7.337 12.9 L 8.137 7.7 C 8.137 7.4 8.437 7.2 8.737 7.2 L 9.237 7.2 C 10.637 7.2 11.937 7.2 12.637 8 C 13.137 8.4 13.337 9.1 13.137 10.1 Z" />
      <path fill="#003087" d="M 35.437 10 L 31.737 10 C 31.437 10 31.137 10.2 31.137 10.5 L 30.937 11.5 L 30.637 11.1 C 29.837 9.9 28.037 9.5 26.237 9.5 C 22.137 9.5 18.637 12.6 17.937 17 C 17.537 19.2 18.037 21.3 19.337 22.7 C 20.437 24 22.137 24.6 24.037 24.6 C 27.337 24.6 29.237 22.5 29.237 22.5 L 29.037 23.5 C 28.937 23.9 29.237 24.3 29.637 24.3 L 33.037 24.3 C 33.537 24.3 34.037 23.9 34.137 23.4 L 36.137 10.6 C 36.237 10.4 35.837 10 35.437 10 Z M 30.337 17.2 C 29.937 19.3 28.337 20.8 26.137 20.8 C 25.037 20.8 24.237 20.5 23.637 19.8 C 23.037 19.1 22.837 18.2 23.037 17.2 C 23.337 15.1 25.137 13.6 27.237 13.6 C 28.337 13.6 29.137 14 29.737 14.6 C 30.237 15.3 30.437 16.2 30.337 17.2 Z" />
      <path fill="#003087" d="M 55.337 10 L 51.637 10 C 51.237 10 50.937 10.2 50.737 10.5 L 45.537 18.1 L 43.337 10.8 C 43.237 10.3 42.737 10 42.337 10 L 38.637 10 C 38.237 10 37.837 10.4 38.037 10.9 L 42.137 23 L 38.237 28.4 C 37.937 28.8 38.237 29.4 38.737 29.4 L 42.437 29.4 C 42.837 29.4 43.137 29.2 43.337 28.9 L 55.837 10.9 C 56.137 10.6 55.837 10 55.337 10 Z" />
      <path fill="#009cde" d="M 67.737 2.8 L 59.937 2.8 C 59.437 2.8 58.937 3.2 58.837 3.7 L 55.737 23.6 C 55.637 24 55.937 24.3 56.337 24.3 L 60.337 24.3 C 60.737 24.3 61.037 24 61.037 23.7 L 61.937 18 C 62.037 17.5 62.437 17.1 63.037 17.1 L 65.537 17.1 C 70.637 17.1 73.637 14.6 74.437 9.7 C 74.737 7.6 74.437 5.9 73.437 4.7 C 72.237 3.5 70.337 2.8 67.737 2.8 Z M 68.637 10.1 C 68.237 12.9 66.037 12.9 64.037 12.9 L 62.837 12.9 L 63.637 7.7 C 63.637 7.4 63.937 7.2 64.237 7.2 L 64.737 7.2 C 66.137 7.2 67.437 7.2 68.137 8 C 68.637 8.4 68.737 9.1 68.637 10.1 Z" />
      <path fill="#009cde" d="M 90.937 10 L 87.237 10 C 86.937 10 86.637 10.2 86.637 10.5 L 86.437 11.5 L 86.137 11.1 C 85.337 9.9 83.537 9.5 81.737 9.5 C 77.637 9.5 74.137 12.6 73.437 17 C 73.037 19.2 73.537 21.3 74.837 22.7 C 75.937 24 77.637 24.6 79.537 24.6 C 82.837 24.6 84.737 22.5 84.737 22.5 L 84.537 23.5 C 84.437 23.9 84.737 24.3 85.137 24.3 L 88.537 24.3 C 89.037 24.3 89.537 23.9 89.637 23.4 L 91.637 10.6 C 91.637 10.4 91.337 10 90.937 10 Z M 85.737 17.2 C 85.337 19.3 83.737 20.8 81.537 20.8 C 80.437 20.8 79.637 20.5 79.037 19.8 C 78.437 19.1 78.237 18.2 78.437 17.2 C 78.737 15.1 80.537 13.6 82.637 13.6 C 83.737 13.6 84.537 14 85.137 14.6 C 85.737 15.3 85.937 16.2 85.737 17.2 Z" />
      <path fill="#009cde" d="M 95.337 3.3 L 92.137 23.6 C 92.037 24 92.337 24.3 92.737 24.3 L 95.937 24.3 C 96.437 24.3 96.937 23.9 97.037 23.4 L 100.237 3.5 C 100.337 3.1 100.037 2.8 99.637 2.8 L 96.037 2.8 C 95.637 2.8 95.437 3 95.337 3.3 Z" />
    </svg>
  );
}

// ───────────── Checkout (réplica del checkout de Shopify de ceium.net) ─────────────
type SvgProps = React.SVGProps<SVGSVGElement>;
const ico = { "aria-hidden": true, focusable: false } as const;

/** Bolsa del header del checkout (enlace al carrito). */
export function BagIcon(p: SvgProps) {
  return (
    <svg {...ico} viewBox="0 0 14 14" fill="none" {...p}>
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.1" d="M4.5 4.5V3.9a2.5 2.5 0 0 1 5 0v.6m-7 0h9l.6 7.1a1.2 1.2 0 0 1-1.2 1.3H3.1a1.2 1.2 0 0 1-1.2-1.3z" />
      <path stroke="currentColor" strokeLinecap="round" strokeWidth="1.1" d="M4.8 7.1a2.2 2.2 0 0 0 4.4 0" />
    </svg>
  );
}

export function HelpIcon(p: SvgProps) {
  return (
    <svg {...ico} viewBox="0 0 14 14" fill="none" {...p}>
      <circle cx="7" cy="7" r="6.1" stroke="currentColor" strokeWidth="1.1" />
      <path stroke="currentColor" strokeLinecap="round" strokeWidth="1.1" d="M5.4 5.4a1.65 1.65 0 1 1 2.3 1.5c-.4.2-.7.5-.7.9v.4" />
      <circle cx="7" cy="10" r=".7" fill="currentColor" />
    </svg>
  );
}

export function ChevronDownIcon(p: SvgProps) {
  return (
    <svg {...ico} viewBox="0 0 14 14" fill="none" {...p}>
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" d="m11.9 5.6-4.8 4.2L2.2 5.6" />
    </svg>
  );
}

export function ClockIcon(p: SvgProps) {
  return (
    <svg {...ico} viewBox="0 0 20 20" fill="none" {...p}>
      <circle cx="10" cy="10" r="8.25" stroke="currentColor" strokeWidth="1.5" />
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M10 5.5V10l3 2" />
    </svg>
  );
}

export function LockIcon(p: SvgProps) {
  return (
    <svg {...ico} viewBox="0 0 14 14" fill="none" {...p}>
      <rect width="9" height="6.5" x="2.5" y="6" stroke="currentColor" strokeWidth="1.1" rx="1.4" />
      <path stroke="currentColor" strokeWidth="1.1" d="M4.4 6V4.3a2.6 2.6 0 0 1 5.2 0V6" />
    </svg>
  );
}

export function CopyIcon(p: SvgProps) {
  return (
    <svg {...ico} viewBox="0 0 14 14" fill="none" {...p}>
      <rect width="7.6" height="7.6" x="4.9" y="4.9" stroke="currentColor" strokeWidth="1.1" rx="1.4" />
      <path stroke="currentColor" strokeLinecap="round" strokeWidth="1.1" d="M9.1 2.9V2.6c0-.7-.5-1.2-1.2-1.2H2.6c-.7 0-1.2.5-1.2 1.2v5.3c0 .7.5 1.2 1.2 1.2h.3" />
    </svg>
  );
}

export function CheckIcon(p: SvgProps) {
  return (
    <svg {...ico} viewBox="0 0 14 14" fill="none" {...p}>
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" d="m2.5 7.4 2.9 2.9 6.1-6.6" />
    </svg>
  );
}

export function FieldErrorIcon(p: SvgProps) {
  return (
    <svg {...ico} viewBox="0 0 14 14" fill="none" {...p}>
      <circle cx="7" cy="7" r="6.1" stroke="currentColor" strokeWidth="1.1" />
      <path stroke="currentColor" strokeLinecap="round" strokeWidth="1.2" d="M7 3.9v3.7" />
      <circle cx="7" cy="9.9" r=".75" fill="currentColor" />
    </svg>
  );
}

// ───────────── Página del pedido ─────────────
export function MapPinIcon(p: SvgProps) {
  return (
    <svg {...ico} viewBox="0 0 16 16" fill="none" {...p}>
      <path stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" d="M8 14.5s4.8-4.3 4.8-8A4.8 4.8 0 0 0 3.2 6.5c0 3.7 4.8 8 4.8 8Z" />
      <circle cx="8" cy="6.5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function CalendarIcon(p: SvgProps) {
  return (
    <svg {...ico} viewBox="0 0 16 16" fill="none" {...p}>
      <rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4" />
    </svg>
  );
}

export function MailIcon(p: SvgProps) {
  return (
    <svg {...ico} viewBox="0 0 16 16" fill="none" {...p}>
      <rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.8" stroke="currentColor" strokeWidth="1.3" />
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" d="m2.4 4.2 5.6 4.3 5.6-4.3" />
    </svg>
  );
}

export function BankIcon(p: SvgProps) {
  return (
    <svg {...ico} viewBox="0 0 16 16" fill="none" {...p}>
      <path stroke="currentColor" strokeLinejoin="round" strokeWidth="1.2" d="M1.8 5.6 8 2.2l6.2 3.4H1.8Z" />
      <path stroke="currentColor" strokeLinecap="round" strokeWidth="1.2" d="M3.4 7.2v4.6M6.4 7.2v4.6M9.6 7.2v4.6M12.6 7.2v4.6M1.8 13.6h12.4" />
    </svg>
  );
}

export function PhoneIcon(p: SvgProps) {
  return (
    <svg {...ico} viewBox="0 0 16 16" fill="none" {...p}>
      <rect x="4.2" y="1.6" width="7.6" height="12.8" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" d="M7 12h2" />
    </svg>
  );
}
