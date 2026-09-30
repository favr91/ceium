// Personal de CEIUM (sección de /pages/quienes-somos): tipos, el equipo por defecto (el de ceium.net) y la lectura
// tolerante de lo guardado en la Setting `store.pages` («quienes-somos».team). Sin dependencias: lo usan la
// tienda (pages-data) y el panel (server/about-team.ts).

export const TEAM_PAGE = "quienes-somos";

export interface TeamMember {
  /** Estable entre ediciones (clave de la lista en el panel). */
  id: string;
  name: string;
  role: string;
  /** https://… (CDN de Shopify) o /uploads/team/… (subida desde el panel). */
  photo: string;
  /** Oculta en la tienda; sigue en la lista del panel para volver a mostrarla. */
  hidden?: boolean;
}

export interface TeamSection {
  title: string;
  text: string;
  members: TeamMember[];
}

const CDN = "https://cdn.shopify.com/s/files/1/0653/7986/0524/files";

export const DEFAULT_TEAM: TeamSection = {
  title: "Personal de CEIUM",
  text: "Contamos con un grupo de expertos apasionados por la enseñanza, comprometidos con guiarte en cada paso de tu aprendizaje.",
  members: [
    { id: "carlos-roa", name: "Dr. Carlos Roa", role: "Director y fundador", photo: `${CDN}/Rectangle_46.jpg?v=1733449728` },
    { id: "mireya-montes-de-oca", name: "Dra. Mireya Montes de Oca", role: "Coordinadora académica", photo: `${CDN}/mireya-montes-de-oca.png?v=1736280676` },
    { id: "flor-montes-de-oca", name: "Ing. Flor Montes de Oca", role: "Coordinadora de la plataforma tecnológica educativa", photo: `${CDN}/flor-montesdeoca.png?v=1736280804` },
    { id: "william-polanco", name: "Ing. William Polanco", role: "Asesor de tecnología de la información", photo: `${CDN}/william-polanco.png?v=1736280887` },
    { id: "nancy-montes-de-oca", name: "Prof. Nancy Montes de Oca", role: "Coordinadora de Control de Estudios", photo: `${CDN}/nancy-montes-de-oca.png?v=1736281414` },
    { id: "rosmary-pinto", name: "Licda. Rosmary Pinto", role: "Asistente administrativa de Control de Estudios", photo: `${CDN}/rosmary-pinto.png?v=1736281260` },
    { id: "nerza-roa", name: "Prof. Nerza Roa", role: "Asesor pedagógico", photo: `${CDN}/nersa-roa.png?v=1736281679` },
    { id: "david-toledo", name: "Licdo. David Toledo", role: "Asistente administrativo logístico", photo: `${CDN}/david-toledo.png?v=1736281162` },
  ],
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ID_RE = /^[\w-]{1,40}$/;

/**
 * La sección tal como está guardada (o la de ceium.net si no hay nada): lo que falta toma el valor por defecto,
 * las personas sin nombre se descartan y las que no tienen `id` (guardadas antes de existir el editor) reciben
 * uno por su posición.
 */
export function readTeam(raw: unknown): TeamSection {
  const o = isRecord(raw) ? raw : {};
  const list = Array.isArray(o.members) ? o.members : DEFAULT_TEAM.members;
  const seen = new Set<string>();
  const members = list.flatMap((m, i): TeamMember[] => {
    if (!isRecord(m) || typeof m.name !== "string" || !m.name.trim()) return [];
    let id = typeof m.id === "string" && ID_RE.test(m.id) ? m.id : `m${i + 1}`;
    while (seen.has(id)) id = `${id.slice(0, 36)}-${i + 1}`;
    seen.add(id);
    return [{ id, name: m.name, role: typeof m.role === "string" ? m.role : "", photo: typeof m.photo === "string" ? m.photo : "", ...(m.hidden === true ? { hidden: true } : {}) }];
  });
  return {
    title: typeof o.title === "string" && o.title.trim() ? o.title : DEFAULT_TEAM.title,
    text: typeof o.text === "string" ? o.text : DEFAULT_TEAM.text,
    members,
  };
}

/** Lo que muestra la tienda: sin las personas ocultas ni las que aún no tienen foto. */
export function publicTeam(raw: unknown): TeamSection {
  const team = readTeam(raw);
  return { ...team, members: team.members.filter((m) => !m.hidden && m.photo) };
}
