"use client";
// Contexto de la ficha del pedido: ejecutar una acción del servidor con estado de envío, toast y refresco.
import { useRouter } from "next/navigation";
import { createContext, useContext, useState, useTransition } from "react";
import { useToast } from "../ui";
import type { ActionResult } from "@/app/admin/(panel)/orders/actions";

export interface Perms {
  verify: boolean;
  refund: boolean;
  adjust: boolean;
  cancel: boolean;
  reassign: boolean;
  enroll: boolean;
  resend: boolean;
  note: boolean;
}

interface Ctx {
  perms: Perms;
  busy: string | null;
  /** Ejecuta la acción; devuelve el resultado (el toast y el refresco ya están hechos). */
  run: (key: string, fn: () => Promise<ActionResult>) => Promise<ActionResult>;
  toast: (text: string, error?: boolean) => void;
}

const OrderCtx = createContext<Ctx | null>(null);

export function OrderProvider({ perms, children }: { perms: Perms; children: React.ReactNode }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();
  const run: Ctx["run"] = async (key, fn) => {
    setBusy(key);
    try {
      const r = await fn();
      if (r.ok) toast.show(r.message);
      else if (!r.needsConfirmRepeat) toast.show(r.error, true);
      start(() => router.refresh());
      return r;
    } catch (e) {
      const msg = "No pudimos completar la acción. Revisa tu conexión e intenta de nuevo.";
      console.error(e);
      toast.show(msg, true);
      return { ok: false, error: msg };
    } finally {
      setBusy(null);
    }
  };
  return (
    <OrderCtx.Provider value={{ perms, busy, run, toast: toast.show }}>
      {children}
      {toast.node}
    </OrderCtx.Provider>
  );
}

export function useOrder() {
  const c = useContext(OrderCtx);
  if (!c) throw new Error("useOrder fuera de OrderProvider");
  return c;
}
