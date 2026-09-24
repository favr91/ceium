// Tipos compartidos (servidor ↔ cliente) de las páginas de Programas del panel. Solo datos serializables.
export type Category = "UNIVERSITY_COURSE" | "ADVANCED_COURSE" | "WORKSHOP" | "DIPLOMA";
export type ProductType = "COURSE" | "DIPLOMA";
export type Status = "ACTIVE" | "DRAFT" | "ARCHIVED";
export type Modality = "ONLINE" | "SEMIPRESENCIAL";
export type PlanKind = "FULL" | "HALF" | "MONTHLY";

export const CATEGORY_LABEL: Record<Category, string> = {
  DIPLOMA: "Diplomado",
  UNIVERSITY_COURSE: "Curso universitario",
  ADVANCED_COURSE: "Curso avanzado",
  WORKSHOP: "Taller",
};
export const CATEGORY_ORDER: Category[] = ["DIPLOMA", "UNIVERSITY_COURSE", "ADVANCED_COURSE", "WORKSHOP"];
export const STATUS_LABEL: Record<Status, string> = { ACTIVE: "Activo", DRAFT: "Borrador", ARCHIVED: "Archivado" };
export const PLAN_LABEL: Record<PlanKind, string> = { FULL: "Pago total", HALF: "Mitad ahora", MONTHLY: "Mes a mes" };

/** Activo = publicado; Borrador = nunca publicado; Archivado = se publicó y luego se retiró de la tienda. */
export function statusOf(p: { published: boolean; publishedAt: Date | string | null }): Status {
  return p.published ? "ACTIVE" : p.publishedAt ? "ARCHIVED" : "DRAFT";
}

export interface ProductRow {
  id: string;
  title: string;
  slug: string;
  type: ProductType;
  category: Category;
  status: Status;
  image: string | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
  priceCount: number;
  online: boolean;
  semi: boolean;
  courseCount: number;
  moodleCourseId: number | null;
  cohortsOpen: number;
  collections: string[];
  updatedAt: string;
}

export interface ImageItem { id: string; url: string; alt: string | null }

export interface PriceCell {
  id: string | null;
  modality: Modality;
  sedeId: string | null;
  choiceId: string | null;
  /** Dólares como texto del input ("1420" / "1420.00"); "" = sin precio en este alcance. */
  price: string;
  installment: string;
  active: boolean;
}

export interface PlanRow { id: string | null; kind: PlanKind; label: string; discountPct: string; installments: number; active: boolean; enabled: boolean }

export interface ChoiceItem { id: string; groupName: string; label: string; moodleCourseIds: number[] | null }

export interface ProductForm {
  id: string | null;
  type: ProductType;
  category: Category;
  title: string;
  slug: string;
  descriptionHtml: string;
  excerpt: string;
  offersOnline: boolean;
  offersSemipresencial: boolean;
  published: boolean;
  publishedAt: string | null;
  moodleCourseId: string;
  requirements: string;
  certificateTitle: string;
  certificateText: string;
  endorsementTitle: string;
  endorsementText: string;
  audience: string;
  duration: string;
  eventDateText: string;
  enrollmentNote: string;
  enrollmentDeadline: string;
  syllabusUrl: string;
  faculty: string;
  benefits: string;
  seoTitle: string;
  seoDescription: string;
  prices: PriceCell[];
  plans: PlanRow[];
  courseIds: string[];
  collectionIds: string[];
}

export interface EditorContext {
  sedes: { id: string; name: string; active: boolean }[];
  courses: { id: string; title: string; moodleCourseId: number | null; status: Status; category: Category }[];
  collections: { id: string; title: string; slug: string; diplomaId: string | null }[];
  choices: ChoiceItem[];
  images: ImageItem[];
  stats: { orders: number; liveOrders: number; cohorts: number; cohortsOpen: number; enrollments: number; inDiplomas: { id: string; title: string }[] };
  audit: { id: string; action: string; when: string; who: string | null; note: string | null; fields: string[] }[];
  prevId: string | null;
  nextId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Alta: planes sugeridos por tipo (al cambiar de curso a diplomado en el formulario). */
  defaultPlans?: Record<ProductType, PlanRow[]>;
}

export interface SaveResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** Sección en la que falló (para resaltarla). */
  section?: string;
  /** Mensajes informativos (p.ej. compras vigentes que conservan la lista de cursos anterior). */
  notes?: string[];
}
