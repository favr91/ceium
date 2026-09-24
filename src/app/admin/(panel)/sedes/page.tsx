import type { Metadata } from "next";
import { can } from "@/server/auth";
import { requireAdminPage } from "../../_lib/session";
import { sedeRows } from "../cohorts/data";
import { SedesManager } from "@/components/admin/cohorts/SedesManager";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sedes" };

export default async function SedesPage() {
  const user = await requireAdminPage("cohorts.manage", "/admin/sedes");
  const sedes = await sedeRows();
  return (
    <div className="adm-page">
      <SedesManager sedes={sedes} canEdit={can(user, "catalog.manage")} />
    </div>
  );
}
