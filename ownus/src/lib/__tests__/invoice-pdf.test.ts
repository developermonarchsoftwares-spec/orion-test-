import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoicePdf, invoicePdfFileName, money, pdfSafe, type InvoiceForPdf } from '../invoice-pdf.ts';

const invoice = (over: Partial<InvoiceForPdf> = {}): InvoiceForPdf => ({
  invoiceNumber: 'INV-2026-000002',
  status: 'ISSUED',
  issuedAt: '2026-10-14T11:39:42.126Z',
  billingName: 'Kathir Rajput',
  billingEmail: 'kathirrithish06@gmail.com',
  paymentId: 'pay_Tnm6Aj7tb2qTol',
  description: 'Purchased Agency Pack (1500 credits)',
  credits: 1500,
  subtotalPaise: 99900,
  taxBps: 0,
  taxPaise: 0,
  totalPaise: 99900,
  currency: 'INR',
  refundedAt: null,
  seller: { name: 'Orion', address: '12 Example Road, Coimbatore', taxId: '33ABCDE1234F1Z5' },
  ...over,
});

const bytes = (v: InvoiceForPdf) => Buffer.from(buildInvoicePdf(v).output('arraybuffer'));
// PDF text strings escape ( ) and \ with a backslash; undo that so the checks read like the visible text
const text = (b: Buffer) => b.toString('latin1').replace(/\\([()\\])/g, '$1');

test('produces a structurally valid PDF: header, one page, cross-reference table, end marker', () => {
  const b = bytes(invoice());
  const s = b.toString('latin1'); // raw bytes: the offsets below are byte positions, so no unescaping here
  assert.equal(s.slice(0, 5), '%PDF-');
  assert.match(s.trimEnd(), /%%EOF$/);
  assert.ok(b.length > 1500, `unexpectedly small (${b.length} bytes)`);
  assert.equal((s.match(/\/Type \/Page\b/g) ?? []).length, 1);
  assert.match(s, /\nxref\n/);
  assert.match(s, /\ntrailer\n/);
  assert.match(s, /startxref\n\d+\n%%EOF/);
  // the startxref offset points exactly at the xref table
  const offset = Number(/startxref\n(\d+)\n%%EOF/.exec(s)![1]);
  assert.equal(s.slice(offset, offset + 4), 'xref');
});

test('the invoice shows the real record: number, customer, payment reference, credits, total, seller and tax id', () => {
  const s = text(bytes(invoice()));
  for (const must of ['INV-2026-000002', 'Kathir Rajput', 'kathirrithish06@gmail.com', 'pay_Tnm6Aj7tb2qTol', 'Purchased Agency Pack', '1500', 'INR 999.00', 'Orion', '12 Example Road', 'Tax ID: 33ABCDE1234F1Z5', 'INVOICE', 'Total paid']) {
    assert.ok(s.includes(must), `missing in PDF: ${must}`);
  }
  assert.ok(!s.includes('Valued Customer') && !s.includes('user@example.com'), 'no invented customer details');
});

test('tax and refund details appear only when they exist', () => {
  const plain = text(bytes(invoice()));
  assert.ok(!plain.includes('Tax ('));
  assert.ok(!plain.includes('Refunded on'));
  const taxed = text(bytes(invoice({ taxBps: 1800, taxPaise: 15237, subtotalPaise: 84663, totalPaise: 99900 })));
  assert.ok(taxed.includes('Tax (18.00%, included in price)'));
  assert.ok(taxed.includes('INR 152.37'));
  const refunded = text(bytes(invoice({ status: 'REFUNDED', refundedAt: '2026-10-16T08:00:00Z' })));
  assert.ok(refunded.includes('Refunded on 2026-10-16.'));
  assert.ok(refunded.includes('Status: REFUNDED'));
});

test('a missing seller block, a very long description, and characters the PDF font cannot draw never break the file', () => {
  const b = bytes(invoice({ seller: null, description: 'Purchased pack '.repeat(40), billingName: 'கதிர் Rajput 😀', refundedAt: undefined }));
  const s = text(b);
  assert.equal(s.slice(0, 5), '%PDF-');
  assert.match(s.trimEnd(), /%%EOF$/);
  // 5 Tamil code units and one emoji (2 UTF-16 units): each unit the font cannot draw becomes one "?"; Latin text is untouched
  assert.equal(pdfSafe('கதிர் A 😀'), '????? A ??');
  assert.equal(pdfSafe('Café – Ünïcode'), 'Café ? Ünïcode');
});

test('amounts are written without the rupee sign (the built-in font has none) and with Indian digit grouping', () => {
  assert.equal(money(99900, 'INR'), 'INR 999.00');
  assert.equal(money(12345678, 'INR'), 'INR 1,23,456.78');
  assert.equal(money(0, undefined), 'INR 0.00');
  assert.ok(!money(29900, 'INR').includes('₹'));
});

test('the file is named after the invoice and is always a safe .pdf name', () => {
  assert.equal(invoicePdfFileName('INV-2026-000002'), 'INV-2026-000002.pdf');
  assert.equal(invoicePdfFileName('../../etc/passwd'), '.._.._etc_passwd.pdf');
  assert.equal(invoicePdfFileName(''), 'invoice.pdf');
});
