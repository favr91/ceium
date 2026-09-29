import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAccountOverview } from "@/server/admin-account";
import { services } from "@/server/services";
import { AccountView } from "@/components/admin/account/AccountView";
import { currentSession } from "../../_lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Mi cuenta" };

export default async function AccountPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await currentSession();
  if (!s) redirect("/admin/login?next=/admin/account");
  const sp = await searchParams;
  const data = await getAccountOverview(services().deps, s.user.id, s.session.id);
  const left = typeof sp.recuperacion === "string" && /^\d+$/.test(sp.recuperacion) ? Number(sp.recuperacion) : null;
  return <AccountView data={data} prompt={sp.configurar === "2fa"} recoveryLeft={left} />;
}
