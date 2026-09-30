// /cart — «Tu carrito», réplica del carrito Dawn de ceium.net. Todo sale de la BD: el carrito (cookie) guarda
// solo la selección y aquí se vuelve a cotizar cada línea (precio, plan, cohorte y cupos al día).
import type { Metadata } from "next";
import Link from "next/link";
import { CartCtaGuard } from "@/components/checkout/CartCtaGuard";
import { CartItems } from "@/components/checkout/CartItems";
import { ErrorIcon, PayPalWordmark } from "@/components/checkout/icons";
import "@/components/checkout/cart.css";
import { updateCartQuantity } from "./actions";
import { getCart } from "./data";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tu carrito", robots: { index: false, follow: true } };

/** Catálogo completo (el «Seguir comprando» de Shopify apunta a /collections/all). */
const CONTINUE_HREF = "/pages/cursos";

function usd(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default async function CartPage({ searchParams }: PageProps<"/cart">) {
  const sp = await searchParams;
  const addError = typeof sp.error === "string" ? sp.error.slice(0, 300) : null;
  const cart = await getCart();

  if (cart.count === 0) {
    return (
      <div className="ck-cart" data-testid="cart-empty">
        <div className="ck-empty">
          {addError ? <p className="ck-banner" role="alert"><ErrorIcon />{addError}</p> : null}
          <h1 className="ck-empty-title">Tu carrito está vacío</h1>
          <Link href={CONTINUE_HREF} className="ck-btn">Seguir comprando</Link>
          <h2 className="ck-empty-sub">¿Ya hiciste una compra?</h2>
          <p className="ck-empty-p">Consulta el estado de tu pedido con el enlace que te enviamos por correo.</p>
        </div>
      </div>
    );
  }

  const blocked = cart.blocked;
  return (
    <div className="ck-cart">
      <div className="ck-title-row">
        <h1 className="ck-title">Tu carrito</h1>
        <Link href={CONTINUE_HREF} className="ck-link">Seguir comprando</Link>
      </div>
      {addError ? <p className="ck-banner" role="alert"><ErrorIcon />{addError}</p> : null}

      <CartItems lines={cart.lines} updateQuantity={updateCartQuantity} />

      <div className="ck-footer" id="main-cart-footer">
        <div className="ck-blocks">
          {cart.discountCents > 0 ? (
            <dl className="ck-summary" data-testid="cart-summary">
              <div>
                <dt>Subtotal</dt>
                <dd>{usd(cart.programTotalCents + cart.discountCents)}</dd>
              </div>
              <div className="ck-summary-save">
                <dt>Descuento por forma de pago</dt>
                <dd data-testid="cart-discount">−{usd(cart.discountCents)}</dd>
              </div>
              {cart.hasSplitPlans ? (
                <div>
                  <dt>Total de los programas</dt>
                  <dd>{usd(cart.programTotalCents)}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          <div className="ck-totals">
            <h2 className="ck-totals-label">Total estimado</h2>
            <p className="ck-totals-value" data-testid="cart-total">{usd(cart.dueNowCents)} USD</p>
          </div>
          <small className="ck-tax-note">
            {cart.discountCents > 0 ? "Descuentos incluidos. " : ""}Sin impuestos ni envío. El método de pago se elige en la pantalla de pago.
          </small>
          {cart.hasSplitPlans ? (
            <small className="ck-split-note">
              Total de los programas: <strong>{usd(cart.programTotalCents)}</strong>. Hoy pagas el primer pago; el saldo queda en tu pedido.
            </small>
          ) : null}
          <div className="ck-ctas">
            {blocked ? (
              <span className="ck-btn" role="link" aria-disabled="true" id="checkout" data-ck-cta>Pagar pedido</span>
            ) : (
              <Link href="/checkout" className="ck-btn" id="checkout" data-ck-cta>Pagar pedido</Link>
            )}
          </div>
          {blocked ? <p className="ck-blocked-note">Corrige o elimina los programas marcados para continuar.</p> : null}
          <div className="ck-paypal-wrap">
            <Link href="/checkout?metodo=paypal" className="ck-paypal" data-ck-cta aria-label="Pagar con PayPal" aria-disabled={blocked ? "true" : undefined} tabIndex={blocked ? -1 : undefined}>
              <PayPalWordmark />
            </Link>
          </div>
        </div>
      </div>
      <CartCtaGuard />
    </div>
  );
}
