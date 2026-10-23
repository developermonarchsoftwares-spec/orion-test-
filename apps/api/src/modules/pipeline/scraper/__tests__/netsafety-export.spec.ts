import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DedupIndex, recordKeys } from '../dedupe';
import { ExportError, csvSafe, formatFor, loadExisting, writeRecords } from '../export';
import { ScrapedRecord } from '../extract';
import { UnsafeUrlError, decodeBody, validateUrl } from '../netsafety';

const PUBLIC = async () => ['93.184.216.34'];

describe('validateUrl', () => {
  it('accepts a public https address', async () => {
    expect(await validateUrl('https://acme.in/x', PUBLIC)).toEqual(['https://acme.in/x', 'acme.in', 443]);
  });

  it.each([
    ['ftp://acme.in/', /scheme/], ['https://user:pw@acme.in/', /credentials/], ['http://localhost/', /blocked/], ['http://metadata.google.internal/', /blocked/],
    ['https://printer.local/', /blocked/], ['https://acme.in:22/', /port 22/], ['http://127.0.0.1/', /non-public/], ['http://169.254.169.254/latest', /non-public/],
    ['http://[::1]/', /non-public/], ['http://10.0.0.5/', /non-public/], ['', /empty/],
  ])('rejects %s', async (url, msg) => {
    await expect(validateUrl(url, PUBLIC)).rejects.toThrow(msg);
    await expect(validateUrl(url, PUBLIC)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects a name that resolves to a private address, even if another address is public', async () => {
    await expect(validateUrl('https://rebind.example/', async () => ['93.184.216.34', '10.1.2.3'])).rejects.toThrow(/non-public/);
  });

  it('reports DNS failures', async () => {
    await expect(validateUrl('https://nx.example/', async () => { throw new Error('ENOTFOUND'); })).rejects.toThrow(/DNS/);
  });
});

describe('decodeBody', () => {
  it('uses the header charset, then UTF-8, then the meta tag, then windows-1252', () => {
    expect(decodeBody(Buffer.from('Café', 'utf8'), 'text/html')).toBe('Café');
    expect(decodeBody(Buffer.from([0x43, 0x61, 0x66, 0xe9]), 'text/html; charset=iso-8859-1')).toBe('Café');
    expect(decodeBody(Buffer.from([0x43, 0x61, 0x66, 0xe9]), 'text/html')).toBe('Café');
    expect(decodeBody(Buffer.concat([Buffer.from('<meta charset="windows-1252">'), Buffer.from([0xe9])]), '')).toContain('é');
  });
});

describe('dedupe', () => {
  it('uses domain, business e-mail, name+phone and name+address as keys, never a bare phone', () => {
    const a = new ScrapedRecord({ business_name: 'Acme Works Pvt Ltd', phone: '+919812345670', email: 'a@gmail.com', website: 'https://www.acme.co.in', source_url: 'https://acme.co.in/' });
    const keys = recordKeys(a);
    expect(keys).toContain('site:acme.co.in');
    expect(keys.some((k) => k.startsWith('mail:'))).toBe(false);            // free mail is too generic
    expect(keys).toContain('namephone:acmeworks|+919812345670');
    expect(keys.some((k) => k === 'phone:+919812345670')).toBe(false);
  });

  it('merges a duplicate into the first record without overwriting', () => {
    const idx = new DedupIndex();
    idx.add(new ScrapedRecord({ business_name: 'Acme', website: 'https://acme.in' }));
    const [isNew, kept] = idx.add(new ScrapedRecord({ business_name: 'ACME Ltd', website: 'https://www.acme.in', phone: '+919812345670' }));
    expect(isNew).toBe(false);
    expect([kept.business_name, kept.phone, idx.duplicates, idx.records.length]).toEqual(['Acme', '+919812345670', 1, 1]);
  });
});

describe('export', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'scraper-export-'));
  const rec = new ScrapedRecord({
    business_name: '=HYPERLINK("x")', phone: '+919812345670', email: 'hi@acme.in', website: 'https://acme.in', address: '1 Road, Pune',
    source_url: 'https://acme.in/', extracted_at: '2026-10-21T00:00:00+00:00', verification_status: 'EXTRACTED_HIGH_CONFIDENCE',
  });

  it('neutralises formulas but leaves E.164 phones alone', () => {
    expect(csvSafe('business_name', '=1+1')).toBe("'=1+1");
    expect(csvSafe('phone', '+919812345670')).toBe('+919812345670');
    expect(csvSafe('address', '-5 Road')).toBe("'-5 Road");
  });

  it('picks the format from the extension unless requested', () => {
    expect([formatFor('a.json'), formatFor('a.csv'), formatFor('a.json', 'CSV')]).toEqual(['json', 'csv', 'csv']);
  });

  it('round-trips CSV, restoring escaped formulas', () => {
    const p = join(dir(), 'out.csv');
    writeRecords(p, [rec], 'csv');
    expect(readFileSync(p, 'utf8')).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
    const back = loadExisting(p, 'csv');
    expect(back).toHaveLength(1);
    expect(back[0].business_name).toBe('=HYPERLINK("x")');
  });

  it('round-trips JSON atomically', () => {
    const p = join(dir(), 'nested', 'out.json');
    writeRecords(p, [rec], 'json');
    expect(loadExisting(p, 'json')[0].phone).toBe('+919812345670');
    expect(existsSync(p)).toBe(true);
  });

  it('refuses to merge into a file with an unexpected layout', () => {
    const p = join(dir(), 'other.csv');
    writeFileSync(p, 'a,b\n1,2\n');
    expect(() => loadExisting(p, 'csv')).toThrow(ExportError);
    expect(loadExisting(join(dir(), 'missing.csv'), 'csv')).toEqual([]);
  });
});
