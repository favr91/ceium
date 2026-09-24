"use client";
// «Revisar en Moodle»: corre ahora el barrido de certificados (el mismo del job periódico).
import { sweepCertificatesAction } from "@/app/admin/(panel)/certificates/actions";
import { Spinner } from "../orders/bits";
import { useRun } from "./shared";

export function SweepButton() {
  const { run, busy, toastNode } = useRun();
  return (
    <>
      <button type="button" className="btn btn-gray" disabled={!!busy} onClick={() => run("sweep", sweepCertificatesAction)}>
        {busy ? <Spinner /> : null} Revisar en Moodle
      </button>
      {toastNode}
    </>
  );
}
