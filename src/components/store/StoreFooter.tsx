// Pie de la tienda (réplica del footer Dawn de ceium.net): redes, teléfonos y sedes desde la BD.
import Link from "next/link";
import type { StoreChrome } from "./chrome-data";
import { SOCIAL_ICONS, SOCIAL_LABELS } from "./icons";

export function StoreFooter({ chrome }: { chrome: StoreChrome }) {
  return (
    <footer className="footer">
      <div className="footer__content-top page-width">
        <div className="footer__blocks-wrapper">
          <div className="footer-block">
            <ul className="list-unstyled list-social footer__list-social" role="list">
              {chrome.social.map((s) => {
                const Icon = SOCIAL_ICONS[s.network];
                return (
                  <li key={s.network} className="list-social__item">
                    <a href={s.url} className="link list-social__link" target="_blank" rel="noopener noreferrer">
                      <span className="svg-wrapper">
                        <Icon />
                      </span>
                      <span className="visually-hidden">{SOCIAL_LABELS[s.network]}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
          {chrome.phones.length ? (
            <div className="footer-block footer-block--menu">
              <h2 className="footer-block__heading">Teléfonos</h2>
              <ul className="footer-block__details-content list-unstyled">
                {chrome.phones.map((p) => (
                  <li key={p.href}>
                    <a href={p.href} className="link link--text list-menu__item list-menu__item--link">
                      {p.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {chrome.sedes.length ? (
            <div className="footer-block footer-block--menu">
              <h2 className="footer-block__heading">Sedes CEIUM</h2>
              <ul className="footer-block__details-content list-unstyled">
                {chrome.sedes.map((s) => (
                  <li key={s.id}>
                    {s.href ? (
                      <a href={s.href} className="link link--text list-menu__item list-menu__item--link" target="_blank" rel="noopener noreferrer">
                        {s.label}
                      </a>
                    ) : (
                      <span className="list-menu__item list-menu__item--link">{s.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
      <div className="footer__content-bottom">
        <div className="footer__content-bottom-wrapper page-width">
          <div className="footer__copyright caption">
            <small className="copyright__content">
              © {chrome.year}, <Link href="/">CEIUM</Link>
            </small>
            <ul className="policies list-unstyled">
              <li>
                <small className="copyright__content">
                  <Link href="/policies/privacy-policy">Política de privacidad</Link>
                </small>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </footer>
  );
}
