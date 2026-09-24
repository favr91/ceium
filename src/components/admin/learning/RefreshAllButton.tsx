"use client";
// «Consultar progreso»: pide a Moodle la finalización de los cursos en curso de la página actual.
import { refreshProgressAction } from "@/app/admin/(panel)/enrollments/actions";
import { Spinner } from "../orders/bits";
import { useRun } from "./shared";

export function RefreshAllButton({ ids, label = "Consultar progreso", primary }: { ids: string[]; label?: string; primary?: boolean }) {
  const { run, busy, toastNode } = useRun();
  return (
    <>
      <button type="button" className={`btn ${primary ? "btn-primary" : "btn-gray"}`} disabled={!ids.length || !!busy} onClick={() => run("all", () => refreshProgressAction(ids))} title={ids.length ? `Consultar ${ids.length} cursos en Moodle` : "No hay cursos en curso en esta página"}>
        {busy ? <Spinner /> : null} {label}
      </button>
      {toastNode}
    </>
  );
}
