import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessWebsite } from '../website-status.ts';

const status = (v: unknown) => assessWebsite(v).status;

test('any valid https:// address passes, whatever the domain extension', () => {
  for (const u of [
    'https://www.vannamdesignhub.in/',
    'https://example.com',
    'https://example.org/path?q=1#top',
    'https://example.net:8443/a/b',
    'https://shop.example.co.uk',
    'https://example.io',
    'https://example.tech',
    'https://example.museum',
    'https://example.photography',
    'https://пример.рф',
    'https://example.xn--p1ai',
    'HTTPS://EXAMPLE.IN/',
    'https://a-b.c-d.example.in',
    'https://xn--80ak6aa92e.com',
  ]) {
    const a = assessWebsite(u);
    assert.equal(a.status, 'valid', u);
    assert.equal(a.secure, true, u);
    assert.equal(a.hasWebsite, true, u);
  }
});

test('Indian and other second-level extensions pass: .co.in, .gov.in, .org.in, .ac.in, .nic.in and more', () => {
  for (const host of [
    'example.co.in', 'www.example.co.in', 'example.gov.in', 'www.tn.gov.in', 'example.org.in', 'example.net.in', 'example.ac.in',
    'example.edu.in', 'example.nic.in', 'example.res.in', 'example.firm.in', 'example.gen.in', 'example.ind.in', 'example.in',
    'example.com.au', 'example.co.uk', 'example.gov.uk', 'example.com.sg', 'example.co.za', 'example.com.br', 'example.co.jp',
  ]) {
    for (const path of ['', '/', '/about', '/a/b?c=d#e']) {
      const a = assessWebsite(`https://${host}${path}`);
      assert.equal(a.status, 'valid', `https://${host}${path}`);
      assert.equal(assessWebsite(`http://${host}${path}`).status, 'warning', `http://${host}${path}`);
    }
  }
});

test('no extension is special: 300 generated extensions all behave the same', () => {
  // deterministic pseudo-random letters, 2 to 24 characters long; a real list of extensions is never consulted
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 300; i++) {
    const len = 2 + (next() % 23);
    let tld = '';
    for (let j = 0; j < len; j++) tld += String.fromCharCode(97 + (next() % 26));
    assert.equal(assessWebsite(`https://site.${tld}`).status, 'valid', tld);
    assert.equal(assessWebsite(`http://site.${tld}`).status, 'warning', tld);
    assert.equal(assessWebsite(`https://a.b.${tld}/x`).secure, true, tld);
  }
});

test('the source contains no hardcoded list of domain extensions', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../website-status.ts', import.meta.url), 'utf8');
  for (const tld of ['.com', '.org', '.net', '.in', '.gov', '.edu', '.co.uk']) {
    // a literal extension may appear only in comments, never in code
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(code.includes(`'${tld}'`) || code.includes(`"${tld}"`), false, `hardcoded ${tld}`);
  }
});

test('http:// is a warning, not a failure, and still counts as having a website', () => {
  for (const u of ['http://www.vannamdesignhub.in/', 'http://example.com', 'HTTP://EXAMPLE.ORG/x']) {
    const a = assessWebsite(u);
    assert.equal(a.status, 'warning', u);
    assert.equal(a.secure, false, u);
    assert.equal(a.hasWebsite, true, u);
    assert.match(a.message, /http:\/\//);
  }
});

test('missing websites keep the existing warning and hasWebsite is false', () => {
  for (const v of ['', '   ', undefined, null]) {
    const a = assessWebsite(v);
    assert.equal(a.status, 'missing');
    assert.equal(a.hasWebsite, false);
    assert.equal(a.message, 'Website missing (lead opportunity).');
    assert.equal(a.value, '');
  }
});

test('a bare address without a scheme is a warning (the API stores it as https://)', () => {
  assert.equal(status('www.example.in'), 'warning');
  assert.equal(status('example.com/about'), 'warning');
  assert.equal(status('//example.org'), 'warning');
});

test('unsafe or malformed values are invalid, but still count as "a website was supplied"', () => {
  for (const u of [
    'javascript:alert(1)',
    'ftp://example.com',
    'data:text/html,hi',
    'mailto:a@b.com',
    'https://',
    'https://localhost',
    'https://example',
    'https://exa mple.com',
    'https://user:pass@example.com',
    'https://example.123',
    'https://-bad-.com',
    'https://example..com',
    'not a url',
  ]) {
    const a = assessWebsite(u);
    assert.equal(a.status, 'invalid', u);
    assert.equal(a.secure, false, u);
    assert.equal(a.hasWebsite, true, u);
  }
  assert.equal(status('https://example.com/' + 'a'.repeat(2100)), 'invalid');
});

test('the value is trimmed and returned exactly as supplied otherwise', () => {
  assert.equal(assessWebsite('  https://example.in/  ').value, 'https://example.in/');
});
