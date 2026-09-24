// /pages/contacto: réplica de la página PageFly de ceium.net (tarjeta con teléfonos, correos, direcciones y
// redes + formulario de contacto que llega al buzón de CEIUM). Teléfonos y correos salen de la Setting
// `store.contact`, las direcciones de las sedes activas (tabla Sede) y las redes del cromo de la tienda.
import type { Metadata } from "next";
import { connection } from "next/server";
import { getStoreChrome, type SocialLink } from "@/components/store/chrome-data";
import { ContactForm } from "@/components/store/pages/ContactForm";
import { getContactPage } from "@/components/store/pages/pages-data";
import "../pages.css";

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const { page } = await getContactPage();
  return { title: "Contacto", description: page.text };
}

const IconPhone = () => (
  <svg className="pg-contact__icon" aria-hidden="true" focusable="false" viewBox="0 0 512 512" width="14" height="14">
    <path
      fill="currentColor"
      d="M164.9 24.6c-7.7-18.6-28-28.5-47.4-23.2l-88 24C12.1 30.2 0 46 0 64C0 311.4 200.6 512 448 512c18 0 33.8-12.1 38.6-29.5l24-88c5.3-19.4-4.6-39.7-23.2-47.4l-96-40c-16.3-6.8-35.2-2.1-46.3 11.6L304.7 368C234.3 334.7 177.3 277.7 144 207.3L193.3 167c13.7-11.2 18.4-30 11.6-46.3l-40-96z"
    />
  </svg>
);

const IconMail = () => (
  <svg className="pg-contact__icon" aria-hidden="true" focusable="false" viewBox="0 0 512 512" width="14" height="14">
    <path
      fill="currentColor"
      d="M48 64C21.5 64 0 85.5 0 112c0 15.1 7.1 29.3 19.2 38.4L236.8 313.6c11.4 8.5 27 8.5 38.4 0L492.8 150.4c12.1-9.1 19.2-23.3 19.2-38.4c0-26.5-21.5-48-48-48H48zM0 176V384c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V176L294.4 339.2c-22.8 17.1-54 17.1-76.8 0L0 176z"
    />
  </svg>
);

const SOCIAL_ICONS: Record<SocialLink["network"], { label: string; viewBox: string; w: number; h: number; d: string }> = {
  instagram: {
    label: "Instagram",
    viewBox: "0 0 448 512",
    w: 21,
    h: 24,
    d: "M224.1 141c-63.6 0-114.9 51.3-114.9 114.9s51.3 114.9 114.9 114.9S339 319.5 339 255.9 287.7 141 224.1 141zm0 189.6c-41.1 0-74.7-33.5-74.7-74.7s33.5-74.7 74.7-74.7 74.7 33.5 74.7 74.7-33.6 74.7-74.7 74.7zm146.4-194.3c0 14.9-12 26.8-26.8 26.8-14.9 0-26.8-12-26.8-26.8s12-26.8 26.8-26.8 26.8 12 26.8 26.8zm76.1 27.2c-1.7-35.9-9.9-67.7-36.2-93.9-26.2-26.2-58-34.4-93.9-36.2-37-2.1-147.9-2.1-184.9 0-35.8 1.7-67.6 9.9-93.9 36.1s-34.4 58-36.2 93.9c-2.1 37-2.1 147.9 0 184.9 1.7 35.9 9.9 67.7 36.2 93.9s58 34.4 93.9 36.2c37 2.1 147.9 2.1 184.9 0 35.9-1.7 67.7-9.9 93.9-36.2 26.2-26.2 34.4-58 36.2-93.9 2.1-37 2.1-147.8 0-184.8zM398.8 388c-7.8 19.6-22.9 34.7-42.6 42.6-29.5 11.7-99.5 9-132.1 9s-102.7 2.6-132.1-9c-19.6-7.8-34.7-22.9-42.6-42.6-11.7-29.5-9-99.5-9-132.1s-2.6-102.7 9-132.1c7.8-19.6 22.9-34.7 42.6-42.6 29.5-11.7 99.5-9 132.1-9s102.7-2.6 132.1 9c19.6 7.8 34.7 22.9 42.6 42.6 11.7 29.5 9 99.5 9 132.1s2.7 102.7-9 132.1z",
  },
  facebook: {
    label: "Facebook",
    viewBox: "0 0 512 512",
    w: 22,
    h: 22,
    d: "M512 256C512 114.6 397.4 0 256 0S0 114.6 0 256C0 376 82.7 476.8 194.2 504.5V334.2H141.4V256h52.8V222.3c0-87.1 39.4-127.5 125-127.5c16.2 0 44.2 3.2 55.7 6.4V172c-6-.6-16.5-1-29.6-1c-42 0-58.2 15.9-58.2 57.2V256h83.6l-14.4 78.2H287V510.1C413.8 494.8 512 386.9 512 256h0z",
  },
  youtube: {
    label: "YouTube",
    viewBox: "0 0 576 512",
    w: 27,
    h: 24,
    d: "M549.655 124.083c-6.281-23.65-24.787-42.276-48.284-48.597C458.781 64 288 64 288 64S117.22 64 74.629 75.486c-23.497 6.322-42.003 24.947-48.284 48.597-11.412 42.867-11.412 132.305-11.412 132.305s0 89.438 11.412 132.305c6.281 23.65 24.787 41.5 48.284 47.821C117.22 448 288 448 288 448s170.78 0 213.371-11.486c23.497-6.321 42.003-24.171 48.284-47.821 11.412-42.867 11.412-132.305 11.412-132.305s0-89.438-11.412-132.305zm-317.51 213.508V175.185l142.739 81.205-142.739 81.201z",
  },
};

/** Orden de las redes en la tarjeta de contacto de ceium.net. */
const SOCIAL_ORDER: SocialLink["network"][] = ["instagram", "facebook", "youtube"];

export default async function ContactPageRoute() {
  await connection();
  const [{ page, phones, emails, sedes }, chrome] = await Promise.all([getContactPage(), getStoreChrome()]);
  const social = SOCIAL_ORDER.map((n) => chrome.social.find((s) => s.network === n)).filter((s): s is SocialLink => Boolean(s));
  return (
    <div className="pg-pf pg-contact">
      <section className="pg-contact__section">
        <div className="pg-container pg-contact__grid">
          <div className="pg-card-box pg-contact__info">
            <h1 className="pg-contact__title">{page.title}</h1>
            <p className="pg-contact__text">{page.text}</p>
            {phones.length || emails.length ? (
              <div className="pg-contact__lists">
                {phones.length ? (
                  <ul className="pg-contact__list pg-contact__list--phones list-unstyled" aria-label="Teléfonos">
                    {phones.map((p) => (
                      <li key={p.href}>
                        <IconPhone />
                        <a href={p.href}>{p.label}</a>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {emails.length ? (
                  <ul className="pg-contact__list pg-contact__list--emails list-unstyled" aria-label="Correos electrónicos">
                    {emails.map((e) => (
                      <li key={e}>
                        <IconMail />
                        <a href={`mailto:${e}`}>{e}</a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {sedes.length ? (
              <>
                <h2 className="pg-contact__subtitle">{page.addressTitle}</h2>
                <div className="pg-contact__sedes">
                  {sedes.map((s) => (
                    <p key={s.name} className="pg-contact__sede">
                      <strong>{s.name}:</strong> {s.address}
                    </p>
                  ))}
                </div>
              </>
            ) : null}
            {social.length ? (
              <>
                <h2 className="pg-contact__subtitle">{page.followTitle}</h2>
                <ul className="pg-contact__social list-unstyled">
                  {social.map((s) => {
                    const icon = SOCIAL_ICONS[s.network];
                    return (
                      <li key={s.network}>
                        <a href={s.url} target="_blank" rel="noopener noreferrer" aria-label={icon.label}>
                          <svg aria-hidden="true" focusable="false" viewBox={icon.viewBox} width={icon.w} height={icon.h}>
                            <path fill="currentColor" d={icon.d} />
                          </svg>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
          </div>
          <div className="pg-card-box pg-contact__form">
            <h2 className="visually-hidden">Envíanos un mensaje</h2>
            <ContactForm submitLabel={page.form.submit} successMessage={page.form.success} />
          </div>
        </div>
      </section>
    </div>
  );
}
