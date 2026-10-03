import { type Cents, formatMoney } from "../lib/money";

export type InvoiceLine = { description: string; quantity: number; unitPrice: Cents };

export type Invoice = {
  number: string;
  issuedOn: string; // YYYY-MM-DD
  dueInDays: number;
  seller: { name: string; address: string[]; vatId?: string };
  buyer: { name: string; address: string[]; email: string };
  lines: InvoiceLine[];
  taxRate: number; // e.g. 0.2 for 20%
  currency: string;
  notes?: string;
  paid?: boolean;
};

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function dueDate(issuedOn: string, dueInDays: number): string {
  const d = new Date(`${issuedOn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dueInDays);
  return d.toISOString().slice(0, 10);
}

export function invoiceTotals(invoice: Invoice) {
  const subtotal = invoice.lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const tax = Math.round(subtotal * invoice.taxRate);
  return { subtotal, tax, total: subtotal + tax };
}

/** Renders the invoice as a standalone HTML document. */
export function renderInvoice(invoice: Invoice): string {
  if (invoice.lines.length === 0) throw new Error("invoice has no lines");
  const money = (c: Cents) => formatMoney(c, invoice.currency);
  const { subtotal, tax, total } = invoiceTotals(invoice);
  const address = (lines: string[]) => lines.map((l) => `<div>${escape(l)}</div>`).join("");
  const rows = invoice.lines
    .map(
      (l) =>
        `<tr><td>${escape(l.description)}</td><td class="num">${l.quantity}</td><td class="num">${money(l.unitPrice)}</td><td class="num">${money(l.unitPrice * l.quantity)}</td></tr>`,
    )
    .join("\n      ");
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Invoice ${escape(invoice.number)}</title></head>
<body>
  <header>
    <h1>Invoice ${escape(invoice.number)}</h1>
    ${invoice.paid ? '<p class="stamp">PAID</p>' : `<p class="due">Due ${dueDate(invoice.issuedOn, invoice.dueInDays)}</p>`}
  </header>
  <section class="parties">
    <div class="seller"><strong>${escape(invoice.seller.name)}</strong>${address(invoice.seller.address)}${invoice.seller.vatId ? `<div>VAT ${escape(invoice.seller.vatId)}</div>` : ""}</div>
    <div class="buyer"><strong>${escape(invoice.buyer.name)}</strong>${address(invoice.buyer.address)}<div>${escape(invoice.buyer.email)}</div></div>
  </section>
  <table>
    <thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead>
    <tbody>
      ${rows}
    </tbody>
    <tfoot>
      <tr><td colspan="3">Subtotal</td><td class="num">${money(subtotal)}</td></tr>
      <tr><td colspan="3">Tax (${(invoice.taxRate * 100).toFixed(1)}%)</td><td class="num">${money(tax)}</td></tr>
      <tr class="total"><td colspan="3">Total</td><td class="num">${money(total)}</td></tr>
    </tfoot>
  </table>
  ${invoice.notes ? `<footer><p>${escape(invoice.notes)}</p></footer>` : ""}
</body>
</html>
`;
}
