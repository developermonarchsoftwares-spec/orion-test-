/**
 * The customer's invoice as a real PDF, built in the browser from the server's own invoice record (GET /billing/invoices/:id).
 * Nothing on the page is typed in by the website: the numbers, names and seller details are exactly what the server stored or is configured with.
 *
 * jsPDF's built-in fonts cover Latin text only and have no rupee sign, so amounts are written as "INR 299.00" and any character the font
 * cannot draw is replaced with "?" instead of printing garbage.
 */
import { jsPDF } from 'jspdf'; // the named export works in the browser bundle and under Node (the default import does not under Node)

export interface InvoiceForPdf {
  invoiceNumber: string;
  status: string;
  issuedAt: string | Date;
  billingName: string;
  billingEmail: string;
  paymentId: string;
  description: string;
  credits: number;
  subtotalPaise: number;
  taxBps?: number | null;
  taxPaise?: number | null;
  totalPaise: number;
  currency?: string | null;
  refundedAt?: string | Date | null;
  seller?: { name?: string; address?: string; taxId?: string } | null;
}

/** Only characters the standard PDF fonts can draw (printable ASCII and Latin-1). */
export const pdfSafe = (value: unknown): string => String(value ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

export const money = (paise: number, currency?: string | null): string =>
  `${currency && currency !== 'INR' ? currency : 'INR'} ${(Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const day = (d: string | Date | null | undefined): string => {
  const date = d ? new Date(d) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : '';
};

export const invoicePdfFileName = (invoiceNumber: string): string => `${String(invoiceNumber).replace(/[^A-Za-z0-9._-]/g, '_') || 'invoice'}.pdf`;

export function buildInvoicePdf(inv: InvoiceForPdf): jsPDF {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const left = 18;
  const right = 192;
  let y = 22;

  const seller = inv.seller ?? {};
  doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(17, 17, 17);
  doc.text(pdfSafe(seller.name || 'Orion'), left, y);
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(102, 102, 102);
  y += 6;
  for (const line of [seller.address, seller.taxId ? `Tax ID: ${seller.taxId}` : ''].filter(Boolean) as string[]) {
    for (const part of doc.splitTextToSize(pdfSafe(line), 110) as string[]) {
      doc.text(part, left, y);
      y += 4.5;
    }
  }

  // title block on the right
  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(17, 17, 17);
  doc.text('INVOICE', right, 22, { align: 'right' });
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(51, 51, 51);
  doc.text(pdfSafe(inv.invoiceNumber), right, 29, { align: 'right' });
  doc.text(`Status: ${pdfSafe(inv.status)}`, right, 34.5, { align: 'right' });

  y = Math.max(y, 40) + 6;
  doc.setDrawColor(210, 210, 210).line(left, y, right, y);
  y += 8;

  doc.setFontSize(10).setTextColor(51, 51, 51);
  const details: Array<[string, string]> = [
    ['Date', day(inv.issuedAt)],
    ['Billed to', `${pdfSafe(inv.billingName)} <${pdfSafe(inv.billingEmail)}>`],
    ['Payment reference', pdfSafe(inv.paymentId)],
  ];
  for (const [label, value] of details) {
    doc.setFont('helvetica', 'bold').text(`${label}:`, left, y);
    doc.setFont('helvetica', 'normal');
    for (const part of doc.splitTextToSize(value, 130) as string[]) {
      doc.text(part, left + 38, y);
      y += 5;
    }
    y += 1;
  }

  // table
  y += 4;
  doc.setFillColor(243, 244, 246).rect(left, y - 5, right - left, 8, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(17, 17, 17);
  doc.text('Description', left + 2, y);
  doc.text('Credits', 138, y, { align: 'right' });
  doc.text('Amount', right - 2, y, { align: 'right' });
  y += 9;

  doc.setFont('helvetica', 'normal').setTextColor(51, 51, 51);
  const descLines = doc.splitTextToSize(pdfSafe(inv.description), 95) as string[];
  doc.text(descLines[0] ?? '', left + 2, y);
  doc.text(String(inv.credits ?? 0), 138, y, { align: 'right' });
  doc.text(money(inv.subtotalPaise, inv.currency), right - 2, y, { align: 'right' });
  for (const extra of descLines.slice(1)) {
    y += 5;
    doc.text(extra, left + 2, y);
  }
  y += 6;

  if (inv.taxBps) {
    doc.text(`Tax (${(Number(inv.taxBps) / 100).toFixed(2)}%, included in price)`, left + 2, y);
    doc.text(money(Number(inv.taxPaise ?? 0), inv.currency), right - 2, y, { align: 'right' });
    y += 6;
  }

  doc.setDrawColor(210, 210, 210).line(left, y - 2, right, y - 2);
  y += 4;
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(17, 17, 17);
  doc.text('Total paid', left + 2, y);
  doc.text(money(inv.totalPaise, inv.currency), right - 2, y, { align: 'right' });
  y += 12;

  if (String(inv.status).toUpperCase() === 'REFUNDED') {
    doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(153, 27, 27);
    doc.text(`Refunded on ${day(inv.refundedAt)}.`, left, y);
    y += 8;
  }

  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(120, 120, 120);
  doc.text('Computer-generated invoice.', left, 280);

  doc.setProperties({ title: `Invoice ${pdfSafe(inv.invoiceNumber)}`, subject: 'Invoice', creator: pdfSafe(seller.name || 'Orion') });
  return doc;
}
