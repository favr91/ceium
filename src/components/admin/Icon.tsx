// Iconos del panel (trazos 20×20 al estilo de Polaris icons). Sin dependencias.
const P: Record<string, string> = {
  home: "M4 9.5 10 4l6 5.5V16a1 1 0 0 1-1 1h-3v-4.5H8V17H5a1 1 0 0 1-1-1V9.5Z",
  order: "M5 3.5h10a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1ZM4 11h3.5l1 1.5h3l1-1.5H16",
  product: "M10 2.8 16.5 6v8L10 17.2 3.5 14V6L10 2.8ZM3.8 6.2 10 9.3l6.2-3.1M10 9.3v7.6",
  customer: "M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4.5 16.5c.8-2.7 3-4 5.5-4s4.7 1.3 5.5 4",
  cohort: "M4 5.5h12a.5.5 0 0 1 .5.5v9.5a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V6a.5.5 0 0 1 .5-.5ZM3.5 9h13M7 3.5v3M13 3.5v3",
  location: "M10 17s5-4.6 5-8.5a5 5 0 0 0-10 0C5 12.4 10 17 10 17Zm0-6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  enroll: "M3 7.5 10 4l7 3.5-7 3.5-7-3.5ZM6 9v4c1 1 2.4 1.5 4 1.5s3-.5 4-1.5V9M17 7.5V12",
  certificate: "M4 4h12v9H4V4Zm3 3h6M7 9.5h4M8 13v3.5l2-1 2 1V13",
  settings: "M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm6.3-1.4.2-2.2-1.9-.6a5 5 0 0 0-.6-1.1l.8-1.8-1.7-1.4-1.6 1.1a5 5 0 0 0-1.2-.4L10 2.6 7.8 3.1l-.3 2a5 5 0 0 0-1.1.6L4.6 5 3.3 6.8l1.1 1.6a5 5 0 0 0-.3 1.2l-1.8.7.2 2.2 1.9.5c.1.4.3.8.6 1.1l-.8 1.8 1.7 1.4 1.6-1.1c.4.2.8.3 1.2.4l.5 1.9h2.2l.4-1.9c.4-.1.8-.3 1.2-.6l1.7 1 1.5-1.6-1-1.6c.2-.4.4-.8.4-1.2l2-.5Z",
  search: "M8.5 14a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM12.5 12.5 17 17",
  back: "M12 4.5 6.5 10l5.5 5.5",
  prev: "M12 5 7 10l5 5",
  next: "M8 5l5 5-5 5",
  chevronDown: "M5.5 8 10 12.5 14.5 8",
  chevronUp: "M5.5 12 10 7.5l4.5 4.5",
  chevronRight: "M8 5.5 12.5 10 8 14.5",
  x: "M5.5 5.5l9 9m0-9-9 9",
  plus: "M10 4.5v11M4.5 10h11",
  drag: "M7.5 5h.01M12.5 5h.01M7.5 10h.01M12.5 10h.01M7.5 15h.01M12.5 15h.01",
  trash: "M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L14 6M8.5 9v4.5M11.5 9v4.5",
  image: "M4 4.5h12a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5Zm-.5 8L7 9l3 3 2-2 4.5 4.5M12.5 8.2a.8.8 0 1 0 0-1.6.8.8 0 0 0 0 1.6Z",
  sort: "M6.5 4v12M3.5 7l3-3 3 3M13.5 16V4M10.5 13l3 3 3-3",
  filter: "M3.5 5.5h13M6 10h8M8.5 14.5h3",
  info: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm0-4V9.5M10 7h.01",
  alert: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm0-10v3.5M10 13h.01",
  check: "M4.5 10.5 8 14l7.5-8",
  external: "M11.5 4.5h4v4M15.5 4.5 9 11M13.5 11.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3",
  menu: "M3.5 5.5h13M3.5 10h13M3.5 14.5h13",
  logout: "M8 4.5H5a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h3M12 7l3 3-3 3M15 10H8",
  globe: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM3 10h14M10 3c2 2 2.8 4.3 2.8 7S12 15 10 17c-2-2-2.8-4.3-2.8-7S8 5 10 3Z",
  bold: "M6.5 4.5H11a2.75 2.75 0 0 1 0 5.5H6.5V4.5Zm0 5.5h5a2.75 2.75 0 0 1 0 5.5h-5V10Z",
  italic: "M9 4.5h5M6 15.5h5M11.5 4.5l-3 11",
  underline: "M6.5 4v5.5a3.5 3.5 0 0 0 7 0V4M5 16.5h10",
  ul: "M8 5.5h8.5M8 10h8.5M8 14.5h8.5M4.25 5.5h.01M4.25 10h.01M4.25 14.5h.01",
  ol: "M8.5 5.5H17M8.5 10H17M8.5 14.5H17M3.5 4.5l1-.5v3M3.5 12h2l-2 2.5h2",
  link: "M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.8.8M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8a3 3 0 0 0 4.2 4.2l.8-.8",
  code: "M7 6 3 10l4 4M13 6l4 4-4 4",
  h: "M5 4.5v11M13 4.5v11M5 10h8",
  wifi: "M3 8a10 10 0 0 1 14 0M5.5 10.5a6.5 6.5 0 0 1 9 0M8 13a3 3 0 0 1 4 0M10 15.5h.01",
  building: "M4.5 16.5V4a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v12.5M12.5 8h2.5a.5.5 0 0 1 .5.5v8M3 16.5h14M7 6.5h1M9.5 6.5h1M7 9.5h1M9.5 9.5h1M7 12.5h1M9.5 12.5h1",
  duplicate: "M7.5 7.5h8v8h-8zM4.5 12.5v-8h8",
  upload: "M10 13V4M6.5 7.5 10 4l3.5 3.5M4.5 13v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V13",
  star: "M10 3.5l2 4.2 4.5.6-3.3 3.1.8 4.5-4-2.2-4 2.2.8-4.5-3.3-3.1 4.5-.6 2-4.2Z",
  archive: "M3.5 4.5h13v3h-13zM4.5 7.5v8h11v-8M8 10.5h4",
  eye: "M2.5 10S5 4.5 10 4.5 17.5 10 17.5 10 15 15.5 10 15.5 2.5 10 2.5 10Zm7.5 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 20, className, title }: { name: IconName | string; size?: number; className?: string; title?: string }) {
  const d = P[name] ?? P.info;
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={name === "drag" ? 2.6 : 1.5} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  );
}
