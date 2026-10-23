import {
  cleanAddress, cleanBusinessName, mailboxKind, nameKey, nameMatch, normalizeEmail, normalizePhone, normalizeUrl, registrableDomain,
} from '../normalize';

describe('normalizeUrl', () => {
  it.each([
    ['Acme.com', 'https://acme.com'],
    ['HTTP://www.Acme.in/', 'http://www.acme.in'],
    ['https://acme.co.in/about/?utm_source=x&id=5#top', 'https://acme.co.in/about?id=5'],
    ['acme.org:443/path', 'https://acme.org/path'],
    ['https://acme.net:8080', 'https://acme.net:8080'],
    ['https://shop.acme.com.au', 'https://shop.acme.com.au'],
    ['https://münchen.de', 'https://xn--mnchen-3ya.de'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeUrl(raw)?.[0]).toBe(expected);
  });

  it.each([null, '', 'localhost', 'http://127.0.0.1', 'http://[::1]/', 'mailto:a@b.com', 'ftp://x.com', 'javascript:alert(1)',
    'http://user:pw@acme.com', 'not a url', 'http://a'])('rejects %s', (raw) => {
    expect(normalizeUrl(raw as string | null)).toBeNull();
  });

  it('keepPath=false returns the origin only', () => {
    expect(normalizeUrl('https://acme.in/contact?x=1', false)?.[0]).toBe('https://acme.in');
  });

  it('registrableDomain understands co.in style suffixes', () => {
    expect(registrableDomain('www.acme.co.in')).toBe('acme.co.in');
    expect(registrableDomain('mail.shop.acme.com')).toBe('acme.com');
  });
});

describe('normalizePhone', () => {
  it.each([
    ['+91 98123 45670', '+919812345670', 'MOBILE'], ['098123-45670', '+919812345670', 'MOBILE'], ['91-9812345670', '+919812345670', 'MOBILE'],
    ['022 2345 6789', '+912223456789', 'LANDLINE'], ['080 2345 6789', '+918023456789', 'LANDLINE'],
    ['1800 123 4567', '+9118001234567', 'TOLL_FREE'], ['+1 (415) 555-2671', '+14155552671', 'INTERNATIONAL'],
    ['0091 98123 45670', '+919812345670', 'MOBILE'],
  ])('%s', (raw, e164, kind) => {
    expect(normalizePhone(raw)).toEqual({ e164, kind });
  });

  it.each([null, '', '12345', '0000000000', '9999999999', '1234567890', '9876543210', 'abc', '2024-05-12', '27AABCU9603R1ZN'])('rejects %s', (raw) => {
    expect(normalizePhone(raw as string | null)).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it.each([['Info@Acme.IN', 'info@acme.in'], ['mailto:Sales@acme.co.in?subject=Hi', 'sales@acme.co.in'], ['a%40b.com', 'a@b.com']])('%s', (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
  });

  it.each(['logo@2x.png', 'user@example.com', 'name@domain.com', 'a@b', 'a@@b.com', 'x@sentry.io', 'bad..dots@acme.com', ''])('rejects %s', (raw) => {
    expect(normalizeEmail(raw)).toBeNull();
  });

  it('classifies mailboxes', () => {
    expect(mailboxKind('no-reply@acme.com')).toBe('AUTOMATED');
    expect(mailboxKind('dev-announce@acme.com')).toBe('LIST');
    expect(mailboxKind('info@acme.com')).toBe('ROLE');
    expect(mailboxKind('ravi@acme.com')).toBe('OTHER');
  });
});

describe('business names and addresses', () => {
  it.each([
    ['Acme Works Pvt Ltd | Precision Parts', 'Acme Works Pvt Ltd'],
    ['Home | Acme Works', 'Acme Works'],
    ['  Caf&eacute; Rio – Best coffee ', 'Café Rio'],
    ['ACME   WORKS', 'ACME WORKS'],
  ])('cleans %s', (raw, expected) => {
    expect(cleanBusinessName(raw)).toBe(expected);
  });

  it.each([null, '', 'Home', '403 Forbidden', 'Just a moment...', '|', 'A'])('%s is not a name', (raw) => {
    expect(cleanBusinessName(raw as string | null)).toBeNull();
  });

  it('nameKey ignores case, punctuation and legal suffixes', () => {
    expect(nameKey('Acme Works Pvt. Ltd.')).toBe(nameKey('ACME WORKS'));
    expect(nameKey('ACME WORKS')).toBe(nameKey('acme  works private limited'));
    expect(nameKey('Acme Works')).not.toBe(nameKey('Acme Traders'));
  });

  it('cleans addresses', () => {
    expect(cleanAddress('  12 MIDC Road ,, Pune ; ')).toBe('12 MIDC Road, Pune');
    expect(cleanAddress('x')).toBeNull();
  });

  it('nameMatch compares names with page titles and the domain', () => {
    expect(nameMatch('Acme Works Pvt Ltd', ['Acme Works'], 'acmeworks.in')[0]).toBe('MATCH');
    expect(nameMatch('Acme Works', ['Totally Different Co'], 'other.com')[0]).toBe('MISMATCH');
    expect(nameMatch('Acme Works', [], 'x.com')[0]).toBe('UNKNOWN');
  });
});
