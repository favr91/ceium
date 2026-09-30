// Inicio del panel (réplica del Home de Shopify): métricas del periodo con gráfica, pendientes del día, avance por
// diplomado y actividad reciente. Todo sale de la BD (src/server/admin-learning.ts → homeDashboard).
import type { Metadata } from "next";
import { homeDashboard } from "@/server/admin-learning";
import { services } from "@/server/services";
import { Icon } from "@/components/admin/Icon";
import { HomeView } from "@/components/admin/learning/HomeView";
import "@/components/admin/orders/orders.css";
import "@/components/admin/learning/learning.css";
import { requireAdminPage } from "../_lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Inicio" };

type SP = Record<string, string | string[] | undefined>;

export default async function AdminHome({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireAdminPage("orders.view", "/admin");
  const sp = await searchParams;
  const raw = Number(Array.isArray(sp.dias) ? sp.dias[0] : sp.dias);
  const days = raw === 7 || raw === 90 ? raw : 30;
  const data = await homeDashboard(services().deps, user, days);
  return (
    <>
      {sp.denied ? (
        <div className="adm-page hm" style={{ paddingBottom: 0 }}>
          <div className="banner critical" role="alert">
            <Icon name="alert" />
            <span>Tu rol no tiene permiso para abrir esa sección. Pide acceso al super administrador.</span>
          </div>
        </div>
      ) : null}
      <HomeView data={data} userName={user.name} />
    </>
  );
}
