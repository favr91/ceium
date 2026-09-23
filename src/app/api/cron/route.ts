// Jobs periódicos por HTTP (cron del hosting / Vercel Cron / curl), protegidos con CRON_SECRET:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://…/api/cron
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" "https://…/api/cron?jobs=paypal,expire"
// Sin CRON_SECRET configurado la ruta queda deshabilitada (503). Equivale a `npm run jobs`.
import crypto from "node:crypto";
import { services } from "@/server/services";
import { ALL_JOBS, type JobName } from "@/server/jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authorized(req: Request, secret: string): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : (req.headers.get("x-cron-secret") ?? "");
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return given.length > 0 && crypto.timingSafeEqual(a, b);
}

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ ok: false, error: "CRON_SECRET no configurado" }, { status: 503 });
  if (!authorized(req, secret)) return Response.json({ ok: false, error: "No autorizado" }, { status: 401 });
  const param = new URL(req.url).searchParams.get("jobs");
  let which: JobName[] = ALL_JOBS;
  if (param) {
    const names = param.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = names.filter((n) => !ALL_JOBS.includes(n as JobName));
    if (unknown.length) return Response.json({ ok: false, error: `Jobs desconocidos: ${unknown.join(", ")}`, jobs: ALL_JOBS }, { status: 400 });
    which = names as JobName[];
  }
  const startedAt = new Date().toISOString();
  const results = await services().jobs.runJobs(which);
  return Response.json({ ok: true, startedAt, jobs: which, results });
}

export const GET = handle;
export const POST = handle;
