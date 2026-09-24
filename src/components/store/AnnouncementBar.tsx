// Barra de anuncio superior (texto editable con la Setting `store.announcement`).
import Link from "next/link";

export function AnnouncementBar({ text, url }: { text: string; url: string | null }) {
  const message = <p className="announcement-bar__message">{text}</p>;
  return (
    <div className="announcement-bar-section" role="region" aria-label="Anuncio">
      <div className="announcement-bar page-width">
        {url ? (
          <Link href={url} className="announcement-bar__link">
            {message}
          </Link>
        ) : (
          message
        )}
      </div>
    </div>
  );
}
