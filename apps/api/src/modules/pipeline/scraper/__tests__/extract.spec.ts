import {
  STATUS_HIGH, STATUS_LOW, STATUS_MEDIUM, STATUS_NONE, discoverContactPages, extractBusiness, jsonldItemlistUrls, revalidate, ScrapedRecord,
} from '../extract';

export const HOME = `<html><head><title>Acme Works Pvt Ltd | Precision Parts</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Acme Works Pvt Ltd",
"telephone":"+91 98123 45670","email":"hello@acmeworks.in","url":"https://www.acmeworks.in/",
"address":{"@type":"PostalAddress","streetAddress":"12 MIDC Road","addressLocality":"Pune","addressRegion":"Maharashtra","postalCode":"411019"}}</script>
<script>var tracking = "9123456780"; var e = "bot@sentry.io";</script></head>
<body><a href="/contact-us">Contact</a> <a href="/about">About</a> <a href="/blog/post-1">Blog</a>
<p>GSTIN 27AABCU9603R1ZN. Order no 9988776655443.</p><pre>print([1, 1, 2, 3, 5, 8])</pre>
<footer>Website by <a href="mailto:design@agencyx.com">AgencyX</a></footer></body></html>`;
export const CONTACT = `<html><head><title>Contact Acme Works</title></head><body><h1>Contact us</h1>
<address>12 MIDC Road, Pune 411019, Maharashtra</address>
<p>Phone: 020 2567 8901 | Mobile: +91 91234 56789 | Fax: 020 2567 8999</p>
<p>Sales: <a href="mailto:Sales@AcmeWorks.in">email us</a> or write to accounts [at] acmeworks [dot] in</p>
<p>Support partner: help@thirdparty.org</p></body></html>`;

const extract = (pages: [string, string][], o = {}) => extractBusiness(pages, o);

describe('extractBusiness', () => {
  it('extracts a representative business site correctly', () => {
    const rec = extract([['https://www.acmeworks.in/', HOME], ['https://www.acmeworks.in/contact-us', CONTACT]], { extractedAt: '2026-10-21T00:00:00+00:00' });
    expect(rec.business_name).toBe('Acme Works Pvt Ltd');
    expect(rec.phone).toBe('+919812345670');
    expect(rec.email).toBe('hello@acmeworks.in');
    expect(rec.website).toBe('https://www.acmeworks.in');
    expect(rec.address).toBe('12 MIDC Road, Pune, Maharashtra, 411019');
    expect(rec.source_url).toBe('https://www.acmeworks.in/');
    expect(rec.extracted_at).toBe('2026-10-21T00:00:00+00:00');
    expect(rec.verification_status).toBe(STATUS_HIGH);
    expect(rec.provenance.phone.method).toBe('JSON_LD');
    expect(rec.provenance.phone.source_url).toBe('https://www.acmeworks.in/');
  });

  it('keeps other contacts as alternatives, never invented or dropped silently', () => {
    const rec = extract([['https://acmeworks.in/', HOME], ['https://acmeworks.in/contact-us', CONTACT]]);
    const alts = new Set<string>(rec.provenance.phone.alternatives);
    expect(alts.has('+912025678901')).toBe(true);
    expect(alts.has('+919123456789')).toBe(true);
    expect(alts.has('+912025678999')).toBe(false);                 // fax
    expect(alts.has('+919988776655') || rec.phone === '+919988776655').toBe(false);   // order number
    expect(alts.has('+919123456780') || rec.phone === '+919123456780').toBe(false);   // number inside a <script>
    expect([...alts].some((x) => x.startsWith('+91111'))).toBe(false);                // code sample
  });

  it('does not attribute third-party and credit-line e-mails to the business', () => {
    const rec = extract([['https://acmeworks.in/', HOME.replace('"email":"hello@acmeworks.in",', '')], ['https://acmeworks.in/contact-us', CONTACT]]);
    const emails = new Set([rec.email, ...rec.provenance.email.alternatives]);
    expect(emails).toEqual(new Set(['sales@acmeworks.in', 'accounts@acmeworks.in']));
  });

  it('does not make a JSON-LD url on another domain the official website', () => {
    const rec = extract([['https://acmeworks.in/', HOME.replace('https://www.acmeworks.in/', 'https://somewhere-else.com/')]]);
    expect(rec.website).toBe('https://acmeworks.in');
    expect(rec.provenance.website.alternatives).toContain('https://somewhere-else.com');
  });

  it('leaves missing fields empty', () => {
    const rec = extract([['https://quiet.in/', '<html><head><title>Quiet Bakery</title></head><body><p>Welcome</p></body></html>']]);
    expect([rec.business_name, rec.website]).toEqual(['Quiet Bakery', 'https://quiet.in']);
    expect([rec.phone, rec.email, rec.address]).toEqual(['', '', '']);
    expect(rec.verification_status).toBe(STATUS_NONE);
    expect(Object.keys(rec.row()).sort()).toEqual(['address', 'business_name', 'email', 'extracted_at', 'phone', 'source_url', 'verification_status', 'website']);
  });

  it.each(['', '<html', '<<<>>>', '<html><body><script>{</script></body></html>', '\u0000\u0001'])('survives junk page %j', (html) => {
    const rec = extract([['https://x.in/', html]]);
    expect([rec.phone, rec.email, rec.verification_status]).toEqual(['', '', STATUS_NONE]);
  });

  it('ignores malformed JSON-LD', () => {
    const rec = extract([['https://bad.in/', '<html><head><title>Bad Co</title><script type="application/ld+json">{ "name": </script></head><body>Phone: +91 98123 45670</body></html>']]);
    expect([rec.business_name, rec.phone]).toEqual(['Bad Co', '+919812345670']);
    expect(rec.verification_status).toBe(STATUS_MEDIUM);
  });

  it('maps confidence levels to status', () => {
    const low = extract([['https://lowc.in/', '<html><head><title>Low Co</title></head><body><p>reach 98123 45670 today</p></body></html>']]);
    expect(low.phone).toBe('+919812345670');
    expect(low.provenance.phone.method).toBe('VISIBLE_TEXT');
    expect(low.verification_status).toBe(STATUS_LOW);
    const tel = extract([['https://telc.in/', "<html><head><title>Tel Co</title></head><body><a href='tel:+919812345670'>call</a></body></html>"]]);
    expect(tel.verification_status).toBe(STATUS_HIGH);
  });

  it('reads microdata', () => {
    const html = '<html><body><div itemscope itemtype="https://schema.org/LocalBusiness"><span itemprop="name">Micro Cafe</span>' +
      '<span itemprop="telephone">+91 98123 45670</span><span itemprop="email">hi@microcafe.in</span>' +
      '<span itemprop="address">4 Lake Road, Mysuru, Karnataka 570001</span></div></body></html>';
    const rec = extract([['https://microcafe.in/', html]]);
    expect([rec.business_name, rec.phone, rec.email]).toEqual(['Micro Cafe', '+919812345670', 'hi@microcafe.in']);
    expect(rec.address).toBe('4 Lake Road, Mysuru, Karnataka 570001');
  });
});

const PROFILE = `<html><body><header>Directory Platform helpline <a href="tel:+911800123456">1800 123 456</a>
<a href="mailto:support@platform.org">support</a></header>
<main><h1 class="biz">Sunrise Traders</h1><div class="addr">7 Market Street, Nagpur</div>
<a class="phone" href="tel:+91 98123 45670">Call</a><a class="mail" href="mailto:contact@sunrise-traders.in">Email</a>
<a class="site" href="https://www.sunrise-traders.in/?utm_source=platform">Visit website</a>
<a href="https://www.facebook.com/sunrise">Facebook</a></main>
<footer>Platform Pvt Ltd, 1 Tech Park. Call +91 99999 11111</footer></body></html>`;

describe('directory profiles', () => {
  const opts = { businessSite: false, excludeDomains: new Set(['platform.org']) };

  it('ignores platform-level contacts', () => {
    const rec = extract([['https://platform.org/p/sunrise', PROFILE]], opts);
    expect(rec.business_name).toBe('Sunrise Traders');
    expect(rec.phone).toBe('+919812345670');
    expect(rec.email).toBe('contact@sunrise-traders.in');
    expect(rec.website).toBe('https://www.sunrise-traders.in');
    expect(rec.source_url).toBe('https://platform.org/p/sunrise');
  });

  it('uses configured selectors', () => {
    const selectors = { business_name: 'h1.biz', address: 'div.addr', phone: 'a.phone', email: 'a.mail', website: 'a.site' };
    const rec = extract([['https://platform.org/p/sunrise', PROFILE]], { ...opts, selectors });
    expect([rec.business_name, rec.phone, rec.email, rec.website, rec.address]).toEqual([
      'Sunrise Traders', '+919812345670', 'contact@sunrise-traders.in', 'https://www.sunrise-traders.in', '7 Market Street, Nagpur']);
    expect(rec.provenance.phone.method).toBe('SELECTOR');
  });

  it('does not crash on an invalid selector', () => {
    const rec = extract([['https://platform.org/p/x', PROFILE]], { ...opts, selectors: { phone: 'a[[[' } });
    expect(rec.business_name).toBe('Sunrise Traders');
  });
});

describe('discovery', () => {
  it('stays on the site and is bounded', () => {
    const html = '<a href="/contact">c</a><a href="/about-us">a</a><a href="https://other.com/contact">x</a><a href="/blog/a">b</a>' +
      '<a href="/a.pdf">p</a><a href="/team/members/deep/path">t</a><a href="/reach-us">r</a><a href="/location">l</a>';
    const found = discoverContactPages('https://acme.in/', html, 3);
    expect(found).toHaveLength(3);
    expect(found.every((u) => u.startsWith('https://acme.in/'))).toBe(true);
    expect(/\/(contact|reach-us)$/.test(found[0])).toBe(true);
    expect(found.some((u) => u.endsWith('.pdf') || u.includes('other.com'))).toBe(false);
  });

  it('reads ItemList urls from JSON-LD', () => {
    const html = '<script type="application/ld+json">{"@type":"ItemList","itemListElement":[' +
      '{"@type":"ListItem","position":1,"url":"https://platform.org/p/a"},{"@type":"ListItem","position":2,"item":{"url":"https://platform.org/p/b"}},' +
      '{"@type":"ListItem","position":3,"item":"https://platform.org/p/c"}]}</script>';
    expect(jsonldItemlistUrls(html)).toEqual(['https://platform.org/p/a', 'https://platform.org/p/b', 'https://platform.org/p/c']);
    expect(jsonldItemlistUrls('<html></html>')).toEqual([]);
  });
});

describe('revalidate', () => {
  it('blanks fields that fail the extraction rules and reports them', () => {
    const rec = new ScrapedRecord({
      business_name: 'Acme', phone: '12345', email: 'no-reply@acme.in', website: 'https://acme.in/path', address: 'x',
      source_url: 'https://acme.in/', extracted_at: 'not a date',
    });
    const dropped = revalidate(rec);
    expect(dropped.sort()).toEqual(['address', 'email', 'phone', 'website']);
    expect(rec.phone).toBe('');
    expect(Number.isNaN(Date.parse(rec.extracted_at))).toBe(false);
  });
});
