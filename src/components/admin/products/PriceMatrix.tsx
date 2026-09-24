"use client";
// Matriz de precios producto × modalidad × sede (× opción de compra), al estilo del editor de variantes de
// Shopify: filas agrupadas (Semipresencial → sedes) con precio de grupo que se aplica a todas las sedes, y las
// columnas calculadas de cada forma de pago (misma fórmula que src/server/pricing.ts).
import { Fragment, useState } from "react";
import { Icon } from "../Icon";
import { parseMoney, planPreview, usd } from "./money";
import type { ChoiceItem, PlanRow, PriceCell, ProductType } from "./types";

interface Props {
  type: ProductType;
  cells: PriceCell[];
  sedes: { id: string; name: string; active: boolean }[];
  choices: ChoiceItem[];
  plans: PlanRow[];
  offersOnline: boolean;
  offersSemi: boolean;
  courseCount: number;
  disabled?: boolean;
  onChange: (cells: PriceCell[]) => void;
}

const same = (a: PriceCell, b: PriceCell) => a.modality === b.modality && a.sedeId === b.sedeId && a.choiceId === b.choiceId;

function MoneyInput({ value, onChange, label, placeholder, invalid, disabled }: { value: string; onChange: (v: string) => void; label: string; placeholder?: string; invalid?: boolean; disabled?: boolean }) {
  return (
    <div className="inp-affix">
      <span className="pre">$</span>
      <input className="inp has-pre num" inputMode="decimal" aria-label={label} placeholder={placeholder ?? "0.00"} value={value} aria-invalid={invalid || undefined} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function PriceMatrix({ type, cells, sedes, choices, plans, offersOnline, offersSemi, courseCount, disabled, onChange }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isDip = type === "DIPLOMA";
  const plan = (k: PlanRow["kind"]) => plans.find((p) => p.kind === k && p.enabled && p.active);
  const full = plan("FULL");
  const half = plan("HALF");
  const monthly = isDip ? plan("MONTHLY") : undefined;
  const sedeName = (id: string | null) => sedes.find((s) => s.id === id)?.name ?? "Sede inactiva";

  const update = (target: PriceCell, patch: Partial<PriceCell>) => onChange(cells.map((c) => (same(c, target) ? { ...c, ...patch } : c)));
  const updateMany = (targets: PriceCell[], patch: Partial<PriceCell>) => onChange(cells.map((c) => (targets.some((t) => same(t, c)) ? { ...c, ...patch } : c)));

  const calc = (c: PriceCell) => {
    const price = parseMoney(c.price);
    const inst = parseMoney(c.installment);
    if (price == null || Number.isNaN(price)) return null;
    return {
      full: full ? planPreview(price, null, "FULL", Number(full.discountPct) || 0, 1) : null,
      half: half ? planPreview(price, null, "HALF", Number(half.discountPct) || 0, 2) : null,
      monthly: monthly && courseCount ? planPreview(price, inst != null && !Number.isNaN(inst) ? inst : null, "MONTHLY", 0, courseCount) : null,
    };
  };

  const calcCells = (c: PriceCell) => {
    const r = c.active ? calc(c) : null;
    return (
      <>
        {isDip ? (
          <td data-l="Cuota mensual">
            <MoneyInput label={`Cuota mensual ${scopeLabel(c)}`} value={c.installment} placeholder="—" disabled={disabled || !parseMoney(c.price)} invalid={Number.isNaN(parseMoney(c.installment) as number)} onChange={(v) => update(c, { installment: v })} />
          </td>
        ) : null}
        <td className="calc plans" data-l="Formas de pago">
          {r && (r.full || r.half || r.monthly) ? (
            <>
              {r.full ? <div title={`${full!.label}: ${usd(r.full.totalCents)}`}><span className="k">Total</span> {usd(r.full.totalCents)}</div> : null}
              {r.half ? <div title={`${half!.label}: ${usd(r.half.dueNowCents)} ahora y ${usd(r.half.totalCents - r.half.dueNowCents)} después`}><span className="k">Mitad</span> {usd(r.half.dueNowCents)}</div> : null}
              {r.monthly ? <div title={`${monthly!.label}: ${r.monthly.n} cuotas, total ${usd(r.monthly.totalCents)}`}><span className="k">Mensual</span> {r.monthly.n} × {usd(r.monthly.dueNowCents)}</div> : null}
            </>
          ) : <span className="subdued">—</span>}
        </td>
        <td data-l="Disponible">
          <input type="checkbox" className="toggle" role="switch" checked={c.active && !!c.price.trim()} disabled={disabled || !c.price.trim()} aria-label={`Disponible ${scopeLabel(c)}`} onChange={(e) => update(c, { active: e.target.checked })} />
        </td>
      </>
    );
  };

  const choiceLabel = (id: string | null) => (id ? choices.find((c) => c.id === id)?.label ?? "Opción eliminada" : "");
  const scopeLabel = (c: PriceCell) => [choiceLabel(c.choiceId), c.modality === "ONLINE" ? "Online" : `Semipresencial ${sedeName(c.sedeId)}`].filter(Boolean).join(" · ");

  const groups: (string | null)[] = choices.length ? choices.map((c) => c.id) : [null];
  const orphanChoice = cells.filter((c) => c.choiceId && !choices.some((x) => x.id === c.choiceId));
  const colCount = isDip ? 5 : 4;

  const invalid = (v: string) => Number.isNaN(parseMoney(v) as number);

  return (
    <div className="pm-scroll">
      <table className="pm" aria-label="Matriz de precios">
        <thead>
          <tr>
            <th>Modalidad y sede</th>
            <th className="w-price">Precio de lista</th>
            {isDip ? <th className="w-price">Cuota mensual</th> : null}
            <th>Formas de pago</th>
            <th>Disponible</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const online = cells.find((c) => c.modality === "ONLINE" && c.choiceId === g);
            const semi = cells.filter((c) => c.modality === "SEMIPRESENCIAL" && c.choiceId === g);
            const key = g ?? "-";
            const open = !collapsed[key];
            const prices = semi.map((c) => c.price.trim());
            const groupPrice = prices.length && prices.every((p) => p === prices[0]) ? prices[0] : "";
            const insts = semi.map((c) => c.installment.trim());
            const groupInst = insts.length && insts.every((p) => p === insts[0]) ? insts[0] : "";
            const withPrice = semi.filter((c) => parseMoney(c.price));
            const mins = withPrice.map((c) => parseMoney(c.price)!);
            return (
              <Fragment key={key}>
                {g ? (
                  <tr className="grp">
                    <td colSpan={colCount}><b>{choiceLabel(g)}</b> <span className="muted">· {choices.find((c) => c.id === g)?.groupName}</span></td>
                  </tr>
                ) : null}
                {offersOnline && online ? (
                  <tr className={online.active && online.price.trim() ? undefined : "off"} data-scope={`ONLINE${g ? ":" + g : ""}`}>
                    <td>
                      <div className="vname">
                                                <div><b>Online</b><div className="small muted">Sin sede</div></div>
                      </div>
                    </td>
                    <td data-l="Precio de lista"><MoneyInput label={`Precio de lista ${scopeLabel(online)}`} value={online.price} placeholder="0.00" invalid={invalid(online.price)} disabled={disabled} onChange={(v) => update(online, { price: v })} /></td>
                    {calcCells(online)}
                  </tr>
                ) : null}
                {offersSemi && semi.length ? (
                  <>
                    <tr className="grp" data-scope={`SEMI${g ? ":" + g : ""}`}>
                      <td>
                        <div className="vname">
                                                    <div>
                            <b>Semipresencial</b>
                            <div>
                              <button type="button" className="expander" aria-expanded={open} onClick={() => setCollapsed({ ...collapsed, [key]: open })}>
                                {semi.length} {semi.length === 1 ? "sede" : "sedes"} <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
                              </button>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td data-l="Todas las sedes">
                        <MoneyInput label={`Precio de lista para todas las sedes${g ? " " + choiceLabel(g) : ""}`} value={groupPrice} placeholder={prices.some(Boolean) ? "Varios" : "0.00"} disabled={disabled} onChange={(v) => updateMany(semi, { price: v })} />
                      </td>
                      {isDip ? (
                        <td data-l="Cuota (todas)">
                          <MoneyInput label={`Cuota mensual para todas las sedes${g ? " " + choiceLabel(g) : ""}`} value={groupInst} placeholder={insts.some(Boolean) ? "Varias" : "—"} disabled={disabled} onChange={(v) => updateMany(semi, { installment: v })} />
                        </td>
                      ) : null}
                      <td className="calc muted plans" data-l="Rango">
                        {mins.length ? (Math.min(...mins) === Math.max(...mins) ? usd(mins[0]) : `${usd(Math.min(...mins))} – ${usd(Math.max(...mins))}`) : "—"}
                        <small>precio de lista en {withPrice.length} de {semi.length} sedes</small>
                      </td>
                      <td data-l="Todas disponibles">
                        <input type="checkbox" className="toggle" role="switch" aria-label={`Semipresencial disponible en todas las sedes${g ? " " + choiceLabel(g) : ""}`} checked={withPrice.length > 0 && withPrice.every((c) => c.active)} disabled={disabled || !withPrice.length} onChange={(e) => updateMany(withPrice, { active: e.target.checked })} />
                      </td>
                    </tr>
                    {open
                      ? semi.map((c) => (
                          <tr key={c.sedeId ?? "x"} className={`child${c.active && c.price.trim() ? "" : " off"}`} data-scope={`SEMIPRESENCIAL:${sedeName(c.sedeId)}${g ? ":" + g : ""}`}>
                            <td><span className="strong">{sedeName(c.sedeId)}</span></td>
                            <td data-l="Precio de lista"><MoneyInput label={`Precio de lista ${scopeLabel(c)}`} value={c.price} placeholder="0.00" invalid={invalid(c.price)} disabled={disabled} onChange={(v) => update(c, { price: v })} /></td>
                            {calcCells(c)}
                          </tr>
                        ))
                      : null}
                  </>
                ) : null}
              </Fragment>
            );
          })}
          {orphanChoice.length ? (
            <tr className="off"><td colSpan={colCount} className="small">Hay {orphanChoice.length} precio(s) de opciones eliminadas; se conservan hasta que los borres.</td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
