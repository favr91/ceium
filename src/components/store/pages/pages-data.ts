// Contenido de las páginas informativas de la tienda (/pages/quienes-somos, /pages/preguntas-frecuentes,
// /pages/contacto y /pages/cursos). Solo servidor.
// Lo editorial (textos, fotos del equipo, preguntas frecuentes, pestañas de cursos) tiene valores por defecto
// tomados de ceium.net y se puede sobreescribir por página con la Setting `store.pages`
// ({ "<handle>": Partial<…Page> }). Lo que es dato del negocio sale SIEMPRE de la BD: teléfonos y correos
// (`store.contact`), sedes y direcciones (tabla Sede), redes sociales (cromo) y los programas de cada pestaña
// de /pages/cursos (colecciones, productos, orden, notas de inscripción).
import { prisma } from "@/server/db";
import { SETTING_KEYS } from "@/server/settings";
import { getCollectionPage, type CollectionProduct } from "@/components/store/collection/collection-data";

export const PAGES_SETTING_KEY = "store.pages";

const CDN = "https://cdn.shopify.com/s/files/1/0653/7986/0524/files";

export interface PageLink {
  label: string;
  url: string;
}

/* ───────────── Quiénes somos ───────────── */
export interface TeamMember {
  name: string;
  role: string;
  photo: string;
}
export interface AboutPage {
  title: string;
  eyebrow: string;
  heading: string;
  hero: { image: string; youtubeId: string; videoTitle: string; playIcon: string };
  about: { title: string; text: string; image: string; imageAlt: string; cta: PageLink };
  team: { title: string; text: string; members: TeamMember[] };
}

export const DEFAULT_ABOUT: AboutPage = {
  title: "Quiénes Somos",
  eyebrow: "Quiénes somos",
  heading: "Centro de Enseñanza\u00a0e Investigación de Ultrasonido en Medicina",
  hero: {
    image: `${CDN}/banner-quienes-somos.jpg?v=1733949639`,
    youtubeId: "g89TX4MwV8Q",
    videoTitle: "Qué es CEIUM",
    playIcon: `${CDN}/play.svg?v=1733348916`,
  },
  about: {
    title: "Sobre CEIUM",
    text:
      "Somos una institución con sede principal en Barquisimeto y sucursales en Caracas y Maracaibo, Venezuela, es una institución que inicia la formación profesional en ultrasonido médico en el año 2002. CEIUM está avalado por el departamento de extensión de UCLA (Universidad Centrooccidental Lisandro Alvarado), Venezuela.",
    image: `${CDN}/somos.png?v=1733949806`,
    imageAlt: "Clase práctica de ecografía en CEIUM",
    cta: { label: "Contáctanos", url: "/pages/contacto" },
  },
  team: {
    title: "Personal de CEIUM",
    text: "Contamos con un grupo de expertos apasionados por la enseñanza, comprometidos con guiarte en cada paso de tu aprendizaje.",
    members: [
      { name: "Dr. Carlos Roa", role: "Director y Fundador", photo: `${CDN}/Rectangle_46.jpg?v=1733449728` },
      { name: "Dra. Mireya Montes de Oca", role: "Coordinadora Académica", photo: `${CDN}/mireya-montes-de-oca.png?v=1736280676` },
      { name: "Ing. Flor Montes de Oca", role: "Coordinadora de la Plataforma Tecnológica Educativa", photo: `${CDN}/flor-montesdeoca.png?v=1736280804` },
      { name: "Ing. William Polanco", role: "Asesor de Tecnología de la Información", photo: `${CDN}/william-polanco.png?v=1736280887` },
      { name: "Prof. Nancy Montes de Oca", role: "Coordinadora de Control de Estudios", photo: `${CDN}/nancy-montes-de-oca.png?v=1736281414` },
      { name: "Licda. Rosmary Pinto", role: "Asistente Administrativo de Control de Estudios", photo: `${CDN}/rosmary-pinto.png?v=1736281260` },
      { name: "Prof. Nerza Roa", role: "Asesor Pedagógico", photo: `${CDN}/nersa-roa.png?v=1736281679` },
      { name: "Licdo. David Toledo", role: "Asistente Administrativo Logístico", photo: `${CDN}/david-toledo.png?v=1736281162` },
    ],
  },
};

/* ───────────── Preguntas frecuentes ───────────── */
export interface FaqItem {
  question: string;
  /** HTML de la respuesta (editorial, lo escribe el equipo de CEIUM). */
  answerHtml: string;
}
export interface FaqPage {
  title: string;
  items: FaqItem[];
  closing: { eyebrow: string; title: string; text: string; image: string; cta: PageLink };
}

const wa = (n: string) => `<a href="https://api.whatsapp.com/send?phone=${n}" target="_blank" rel="noopener">+${n}</a>`;

export const DEFAULT_FAQ: FaqPage = {
  title: "Preguntas Frecuentes",
  items: [
    { question: "¿Los diplomados conducen a especialidad ?", answerHtml: "No, los diplomados no conducen a especialidad." },
    {
      question: "¿Quién puede realizar los cursos y diplomados?",
      answerHtml:
        'El <a href="/products/diplomado-universitario-de-ecografia-integral-en-el-diagnostico-medico">Diplomado Universitario de Ecografía Integral en el Diagnóstico Médico</a> está dirigido a médicos generales o especialistas y estudiantes de VI año de Medicina.<br><br>El <a href="/products/diplomado-universitario-avanzado-de-medicina-materno-fetal">Diplomado Universitario Avanzado en Medicina Materno-Fetal</a> está dirigido a médicos especialistas en Ginecología y Obstetricia o residentes de Ginecología y Obstetricia e Imagenólogos.',
    },
    {
      question: "¿Puedo realizar un curso individual de un diplomado o debo realizarlos todos?",
      answerHtml:
        "Los diplomados están conformados por cursos. Si te interesa solo un curso lo puedes realizar como curso aislado, y recibirás la certificación correspondiente.",
    },
    {
      question: "¿Puedo hacer un (curso) de un diplomado aislado o debo hacerlos todos?",
      answerHtml: `Los diplomados están conformados por , si su interés es un solo curso puede hacerlo y le será avalado igualmente.<br><br>Si puede hacer un Curso. Cuando el alumno (local en Venezuela) solo realiza un curso aislado con práctica presencial, fuera del contexto del Diplomado, debe cancelar 150 $. Para estudiantes en el extranjero, debe contactar a whatsapp:&nbsp;${wa("584125250748")} | ${wa("584125540412")} |&nbsp;${wa("584127716325")}`,
    },
    {
      question: "¿Puedo comenzar con cualquier curso del diplomado y luego completar los faltantes para obtener la certificación?",
      answerHtml:
        "Sí, puedes hacerlo. Sin embargo, debes completar los cursos faltantes, pero solo será posible sin completas todos los cursos en el lapso de tiempo correspondiente a 2 cohortes consecutivas; osea tienes dos cohortes consecutivas para finalizar el diplomado..Por ejemplo, si comienzas en la Cohorte I-2025, debes finalizar en la Cohorte II-2025.",
    },
    { question: "¿Qué modalidades de estudio están disponibles?", answerHtml: "Cualquier curso lo puede realizar 100% Multimodal." },
    { question: "¿Los cursos son apostillables?", answerHtml: "Sí, son 100% apostillables." },
    {
      question: "¿Cómo se desarrollan los Cursos si acudo semi- presencial o lo hago totalmente online?",
      answerHtml:
        "Los cursos se desarrollan a través de una plataforma educativa (MOODLE) donde encontrarás:<br><br>En modalidad online o semipresencial, tendrás acceso a nuestra aula virtual (MOODLE), donde encontrarás una variedad de recursos de estudio disponibles para consulta a lo largo del curso.<br><br>¿Qué tipo de recursos muestran en los cursos?<br><br>• Vídeos de Master Class (Libre demanda)<br>• Presentaciones, Pdf, doc<br>• Tutoriales (vídeos desde instalaciones de CEIUM) donde observará cada una de las técnicas, de abordaje ecográfico de cada órgano o sistema en cada curso.<br>• Estos tutoriales se despliegan en la pantalla de su computadora en 4 campos que usted verá simultáneamente.<br>• Una (1)- La imagen que produce el equipo<br>• Dos (2)- La imagen de la ubicación y Movimiento del transductor sobre el cuerpo de la paciente (2 campos: longitudinal y transversal)<br>• Una (1) El teclado: los botones que activa el operador en el aparato de ecografía<br>• Una(1) Cámara móvil, con acercamiento a la zona de estudio. <br>• Seminarios Web semanales, ZOOM . Viernes por la Tarde y Sábados<br>Sede Barquisimeto: Viernes y sábados de 9:00 a.m. a 4:00 p.m.<br>Sede Caracas: Según cronograma. <br>Sede Maracaibo: Según cronograma.<br>Práctica Online: los cursantes online recibirán la carga teórica y práctica vía online según lo estipulado en la rúbrica de cada curso alojada en el aula virtual .<br><br>Nota: Semanalmente tenemos reuniones transmitidas vía zoom, de las clases que se imparten que también quedan grabadas. Esto se hace para el curso semi-presencial y si coincide con alguien que lo esté haciendo online puede acceder en vivo, si ya terminó el lapso de semipresencial y usted está online, puede ver estos zoom pues quedan grabados en la plataforma de CEIUM.",
    },
    {
      question: "¿Cuántas sesiones de Prácticas?",
      answerHtml:
        "Son 4 sesiones presenciales. Donde 2 son en las mañanas y 2 son en las tardes. (2 días Continuos) al terminar la Teoría.<br><br>&nbsp;¿La práctica puede ser presencial u online?<br><br>•&nbsp;Práctica Presencial el alumno dispondrá de un tutor, se hace en las sedes destinadas a tal fin.<br><br>• Práctica Online: Durante las prácticas presenciales realizamos simultáneamente transmisión en vivo vía zoom y el alumno verá a distancia, todos los casos de la práctica en la comodidad de su computadora : en 4 o 5 campos de su pantalla puede ver:<br><br>1. Como se manejan los controles del equipo.<br>2. La imagen que se forma en el ecógrafo.<br>3. Los cortes y barridos del transductor, realizados por el profesor sobre los pacientes.<br>4. Además puede interactuar con el profesor a distancia.",
    },
    {
      question: "¿Cómo realizan la evaluación?",
      answerHtml:
        "• La evaluación es teórico-práctica.<br>• Evaluación Teórica (totalmente online): 1 examen teórico<br>• Evaluación práctica:<br><br>La práctica de los participantes semi presenciales se evaluará en la misma sede los días establecidos en cronograma.<br><br>La práctica online consiste en enviar material audiovisual de ejecución y diagnósticos de ecografías realizado por el estudiante siguiendo la rúbrica respectiva.<br><br>La puntuación máxima es de 20 puntos y la nota mínima aprobatoria será de 15 puntos La actividad teórica tiene un valor máximo de 8 puntos y la práctica 12 puntos. La nota será la sumatoria de ambas.<br><br>La actividad práctica presencial consta de 2 días de asistencia con un valor de 6 puntos por cada día de práctica , en caso de no poder asistir a alguna de las prácticas.<br><br>El alumno deberá enviar un video por cada día de práctica que esté ausente, con las especificaciones descritas en la rúbrica respectiva para evaluaciones de videos.<br><br>En caso de no cumplir con esta tarea le será reprobada No aplican justificativos.<br><br><strong>Nota: Este sistema de evaluación regirá a partir de la Cohorte I-2025.</strong>",
    },
    {
      question: "¿Existe la posibilidad de reembolso?",
      answerHtml:
        "Una vez que haya formalizado su inscripción y el cursante quiera suspender la continuidad del curso, no tendrá derecho a reembolso, lo cual queda como indemnización a la academia por el cupo reservado.",
    },
    {
      question: "¿Qué sucede si el participante no cancela completamente el curso?",
      answerHtml: "•&nbsp;No se emite constancia ni certificado.<br>•&nbsp;No tiene derecho a presentar ninguna de las evaluaciones.",
    },
    {
      question: "¿Dónde se encuentran ubicadas las sedes?",
      answerHtml:
        '<strong>Sede Barquisimeto:</strong> Av. Andrés Bello entre Carrera 33 y 34 Diagonal al Hospital Pediátrico Policlínica San Javier Piso 1 CDIAT.<br><br><strong>Sede Caracas:</strong> Centro Plaza entre la avenida Francisco de Miranda y 1era Transversal de Los Palos Grandes municipio Chacao, Torre A, piso 16, oficina D, Caracas.<br><br><strong>Sede Maracaibo:</strong> Av. Universidad entre Av. 10 y 12, Urb. La Estrella Unimedica.<br><br>Para mayor información, contacta a la Coordinación del CEIUM: Teléfono: <a href="tel:+584120840407">+58 412-0840407</a> / <a href="tel:+584127716325">+58 412-7716325</a> / <a href="tel:+584125250748">+58 412-5250748</a>&nbsp;/&nbsp;<a href="tel:+584145292295">+58 414-5292295</a><br><br>Colaboradores en otras localidades (sujeto a disponibilidad del tutor)<br><br>• Valera<br>• Maracaibo/Ciudad Ojeda<br>• Coro/Punto&nbsp;Fijo<br>• San Cristóbal<br>• San Antonio del Táchira<br><br>Para prácticas y evaluaciones fuera (Policlínica San Javier Barquisimeto) ciertas condiciones aplican comunicarse con el coordinador al <a href="tel:+584127716325">04127716325</a> Instagram&nbsp;<a href="https://www.instagram.com/ceiumoficial/" target="_blank" rel="noopener">@ceiumoficial</a><br><br><strong>Dirección Sede Principal:</strong> Policlínica San Javier Av. Andrés Bello, entre carreras 33 y 34, diagonal al hospital pediátrico, Barquisimeto Estado Lara, Venezuela Código Postal 3001.<br> <br><strong>Correo electrónico:</strong><br><a href="mailto:registroceium@gmail.com">registroceium@gmail.com</a><br><a href="mailto:roacar@gmail.com">roacar@gmail.com</a><br><strong>Instagram: </strong><a href="https://www.instagram.com/ceiumoficial/" target="_blank" rel="noopener">@ceiumoficial</a><br><strong>Youtube: </strong><a href="https://www.youtube.com/@ceium2447" target="_blank" rel="noopener">Ceium(registroceium)</a> <br><strong>Facebook:</strong>&nbsp;<a href="https://www.facebook.com/ceium/" target="_blank" rel="noopener">CEIUM</a><br><strong>Whatsapp: </strong><a href="https://api.whatsapp.com/send?phone=584120840718" target="_blank" rel="noopener">+584120840718</a>',
    },
  ],
  closing: {
    eyebrow: "¡Inscripciones abiertas!",
    title: "Capacitación en\nUltrasonido a tu alcance",
    text: "Da el primer paso, inscríbete ahora.",
    image: `${CDN}/Frame_27.png?v=1732743002`,
    cta: { label: "Contáctanos", url: "/pages/contacto" },
  },
};

/* ───────────── Contacto ───────────── */
export interface ContactPage {
  title: string;
  text: string;
  addressTitle: string;
  followTitle: string;
  form: { submit: string; success: string };
}

export const DEFAULT_CONTACT: ContactPage = {
  title: "Contáctanos",
  text: "Envíanos un mensaje y nos podremos en contacto contigo lo antes posible.",
  addressTitle: "Dirección",
  followTitle: "Síguenos",
  form: { submit: "Enviar mensaje", success: "¡Gracias por escribirnos! Recibimos tu mensaje y te responderemos lo antes posible." },
};

/* ───────────── Nuestros cursos ───────────── */
export interface CoursesTabConfig {
  label: string;
  /** Slug de la colección cuyos programas publicados (en su orden) llenan la pestaña. */
  collection: string;
  /**
   * Nota bajo el título: "product" = la del programa (como la colección); "status" = solo el estado de inscripción.
   * Como en ceium.net, la nota de estado no se muestra en móvil.
   */
  note: "product" | "status";
}
export interface CoursesPage {
  title: string;
  tabs: CoursesTabConfig[];
}

export const DEFAULT_COURSES: CoursesPage = {
  title: "Nuestros cursos",
  tabs: [
    { label: "Cursos Universitarios Fundamentales", collection: "cursos-universitarios", note: "product" },
    { label: "Cursos Avanzados", collection: "cursos-avanzados", note: "status" },
    { label: "Talleres Especializados", collection: "talleres-especializados", note: "status" },
  ],
};

export const NOTE_STATUS_OPEN = "✍ Inscripciones abiertas";

/* ───────────── carga ───────────── */
type Overrides = {
  "quienes-somos"?: Partial<AboutPage>;
  "preguntas-frecuentes"?: Partial<FaqPage>;
  contacto?: Partial<ContactPage>;
  cursos?: Partial<CoursesPage>;
};

async function overrides(): Promise<Overrides> {
  const row = await prisma.setting.findUnique({ where: { key: PAGES_SETTING_KEY } });
  const v = row?.value;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Overrides) : {};
}

function merge<T extends object>(base: T, over: Partial<T> | undefined): T {
  if (!over || typeof over !== "object") return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined || v === null) continue;
    const b = out[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) && typeof v === "object" && !Array.isArray(v) ? { ...b, ...v } : v;
  }
  return out as T;
}

export async function getAboutPage(): Promise<AboutPage> {
  return merge(DEFAULT_ABOUT, (await overrides())["quienes-somos"]);
}

export async function getFaqPage(): Promise<FaqPage> {
  const page = merge(DEFAULT_FAQ, (await overrides())["preguntas-frecuentes"]);
  return { ...page, items: page.items.filter((i) => i && i.question?.trim()) };
}

export interface ContactData {
  page: ContactPage;
  phones: { label: string; href: string }[];
  emails: string[];
  sedes: { name: string; address: string }[];
}

export async function getContactPage(): Promise<ContactData> {
  const [over, contact, sedes] = await Promise.all([
    overrides(),
    prisma.setting.findUnique({ where: { key: SETTING_KEYS.storeContact } }),
    prisma.sede.findMany({ where: { active: true }, orderBy: { position: "asc" }, select: { name: true, address: true } }),
  ]);
  const c = (contact?.value ?? {}) as { phones?: string[]; emails?: string[] };
  return {
    page: merge(DEFAULT_CONTACT, over.contacto),
    phones: (c.phones ?? []).map((p) => ({ label: p, href: `tel:${p.replace(/[^\d+]/g, "")}` })),
    emails: c.emails ?? [],
    sedes: sedes.map((s) => ({ name: s.name, address: s.address ?? "" })),
  };
}

/** Correos que reciben los mensajes del formulario de contacto (Setting `store.contact`.emails). */
export async function contactInbox(): Promise<string[]> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEYS.storeContact } });
  return (((row?.value ?? {}) as { emails?: string[] }).emails ?? []).filter((e) => /@/.test(e));
}

export interface CoursesTab {
  id: string;
  label: string;
  note: "product" | "status";
  products: CollectionProduct[];
}

export async function getCoursesPage(now: Date = new Date()): Promise<{ title: string; tabs: CoursesTab[] }> {
  const page = merge(DEFAULT_COURSES, (await overrides()).cursos);
  const tabs = await Promise.all(
    page.tabs.map(async (t): Promise<CoursesTab | null> => {
      const coll = await getCollectionPage(t.collection, now);
      if (!coll || coll.products.length === 0) return null;
      return { id: coll.slug, label: t.label || coll.title, note: t.note === "status" ? "status" : "product", products: coll.products };
    }),
  );
  return { title: page.title, tabs: tabs.filter((t): t is CoursesTab => t !== null) };
}
