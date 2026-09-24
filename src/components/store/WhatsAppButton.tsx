// Botón flotante de WhatsApp (número de la Setting `store.contact.whatsapp`).
import { IconWhatsApp } from "./icons";

export function WhatsAppButton({ href }: { href: string }) {
  return (
    <div className="whatsapp-widget">
      <a className="whatsapp-widget__link" href={href} target="_blank" rel="noopener noreferrer" aria-label="Escríbenos por WhatsApp">
        <IconWhatsApp width={63} height={63} />
      </a>
    </div>
  );
}
