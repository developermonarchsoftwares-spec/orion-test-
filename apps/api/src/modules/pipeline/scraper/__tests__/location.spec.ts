import { extractBusiness } from '../extract';
import { LocationError, LocationSet, norm } from '../location';
import { Runner } from '../runner';
import { FakeWeb, makeFetcher } from './fake-web';

const IMPORT_CSV =
  'Business Name,Address,City,State,Pincode,Phone,Email,Website,Industry\n' +
  'SS AGRI EXPORTS,"9/7, G R G GARDEN, COIMBATORE",Coimbatore,Tamil Nadu,641008,9384778427,,,Wholesale\n' +
  'ALPHA AIR SYSTEM,"SITE NO. 17, IRUGUR",Coimbatore,Tamil Nadu,641103,9000000001,,,Manufacturing\n' +
  'KALAIVANI,"MARKET ROAD, POLLACHI",Pollachi,Tamil Nadu,642001,9000000002,,,Retail\n' +
  'SHRI VIMAL,"SOUTH STREET, PAZHANKOTTAI",Tenkasi ,Tamil Nadu,627754,9000000003,,,Retail\n';

const loc = () => LocationSet.fromCsvText(IMPORT_CSV);

describe('reading the imported location', () => {
  it('defines places, states and PIN areas from the import file', () => {
    const l = loc();
    expect(new Set(l.places.flatMap((p) => [...p.cities]))).toEqual(new Set(['coimbatore', 'pollachi', 'tenkasi']));
    expect(l.states).toEqual(new Set(['tamil nadu']));
    expect(l.pinAreas).toEqual(new Set(['641', '642', '627']));
    expect(l.pincodes.has('641008')).toBe(true);
  });

  it('ignores other columns and header case', () => {
    const l = LocationSet.fromCsvText('name,CITY,Province,Postal Code\nA,Salem,Tamil Nadu,636001\n');
    expect(l.places[0].cities).toEqual(new Set(['salem']));
    expect(l.pinAreas).toEqual(new Set(['636']));
  });

  it('reads plain text lists and explicit values', () => {
    const l = LocationSet.fromCsvText('# my places\nCoimbatore, Tamil Nadu\nPollachi|Pollachchi, Tamil Nadu\n641008\n');
    const cities = new Set(l.places.flatMap((p) => [...p.cities]));
    expect(['coimbatore', 'pollachi', 'pollachchi'].every((c) => cities.has(c))).toBe(true);
    expect(l.pincodes.has('641008')).toBe(true);
    const one = new LocationSet();
    one.addText('Tamil Nadu');
    expect(one.states).toEqual(new Set(['tamil nadu']));
    expect(one.places[0].cities.size).toBe(0);
  });

  it.each(['', 'id,qty\n1,2\n'])('refuses a file without usable locations %j', (content) => {
    expect(() => LocationSet.fromCsvText(content)).toThrow(LocationError);
    expect(() => LocationSet.fromCsv('/definitely/missing.csv')).toThrow(LocationError);
  });

  it('normalises', () => {
    expect(norm('  Tiruppur ')).toBe('tiruppur');
    expect(norm('Pondé-cherry')).toBe('ponde cherry');
  });
});

describe('the decision', () => {
  it.each([
    ['103, Nanjudapuram, Coimbatore', 'MATCH'],
    ['Plot 5, Avinashi Road, Coimbatore 641018', 'MATCH'],
    ['Gandhi Nagar, Irugur 641103', 'MATCH'],
    ['5 Lake Road, Tenkasi 627811', 'MATCH'],
    ['Market Road, POLLACHI, Tamil Nadu 642001', 'MATCH'],
    ['12 MIDC Road, Pune 411019, Maharashtra', 'MISMATCH'],
    ['Coimbatore Road, Kochi 682001, Kerala', 'MISMATCH'],
    ['12 Main Road, Chennai 600001, Tamil Nadu', 'MISMATCH'],
    ['Salem 636001 Tamil Nadu', 'MISMATCH'],
    ['Coimbatore, Karnataka', 'MISMATCH'],
    ['Anna Salai, Chennai, Tamil Nadu', 'UNKNOWN'],
    ['Somewhere Street 12', 'UNKNOWN'],
    ['', 'UNKNOWN'],
  ])('%s -> %s', (address, verdict) => {
    expect(loc().check(address).verdict).toBe(verdict);
  });

  it('always gives a reason', () => {
    for (const a of ['12 MIDC Road, Pune 411019, Maharashtra', 'Somewhere Street 12', '', 'Coimbatore']) expect(loc().check(a).reason).toBeTruthy();
  });

  it('needs the right state for a city that exists in two states', () => {
    const l = new LocationSet();
    l.addText('Aurangabad, Maharashtra');
    expect(l.check('Station Road, Aurangabad, Maharashtra').verdict).toBe('MATCH');
    expect(l.check('Station Road, Aurangabad, Bihar').verdict).toBe('MISMATCH');
    expect(l.check('Station Road, Aurangabad').verdict).toBe('MATCH');
  });

  it('supports state-only and PIN-only filters', () => {
    const s = new LocationSet();
    s.addText('Tamil Nadu');
    expect(s.check('Anna Salai, Chennai, Tamil Nadu').verdict).toBe('MATCH');
    expect(s.check('MG Road, Bengaluru, Karnataka').verdict).toBe('MISMATCH');
    expect(s.check('MG Road, Bengaluru').verdict).toBe('UNKNOWN');
    const p = new LocationSet();
    p.addText('641008');
    expect(p.check('Anywhere 641011').verdict).toBe('MATCH');
    expect(p.check('Anywhere 682001').verdict).toBe('MISMATCH');
  });

  it('matches everything without a filter, and never invents a location', () => {
    expect(new LocationSet().check('anything').verdict).toBe('MATCH');
    const l = new LocationSet();
    l.addText('Coimbatore, Tamil Nadu');
    expect(l.check(null).verdict).toBe('UNKNOWN');
  });
});

describe('extraction with a location', () => {
  it('chooses the branch inside the location', () => {
    const html = '<html><head><title>Acme Group</title></head><body><address>1 Anna Salai, Chennai 600002, Tamil Nadu</address>' +
      "<address>22 Avinashi Road, Coimbatore 641018, Tamil Nadu</address><a href='tel:+919812345670'>c</a></body></html>";
    const rec = extractBusiness([['https://acmegroup.in/', html]], { location: loc() });
    expect(rec.address).toBe('22 Avinashi Road, Coimbatore 641018, Tamil Nadu');
    expect(rec.provenance.location.verdict).toBe('MATCH');
  });

  it('keeps the verdict and reason when nothing matches', () => {
    const html = "<html><head><title>Pune Co</title></head><body><address>12 MIDC Road, Pune 411019, Maharashtra</address><a href='tel:+919812345670'>c</a></body></html>";
    const rec = extractBusiness([['https://puneco.in/', html]], { location: loc() });
    expect(rec.provenance.location.verdict).toBe('MISMATCH');
    expect(rec.provenance.location.reason).toContain('maharashtra');
  });
});

const page = (name: string, address: string, phone = '+91 98123 45670') =>
  `<html><head><title>${name}</title></head><body>${address ? `<address>${address}</address>` : ''}<a href='tel:${phone}'>call</a></body></html>`;

const SITES: Record<string, string> = {
  'https://inside.in/': page('Inside Traders', '12 Market Road, Coimbatore 641001, Tamil Nadu'),
  'https://pollachi.in/': page('Pollachi Mills', '7 Temple Street, Pollachi, Tamil Nadu', '+91 98123 45671'),
  'https://pune.in/': page('Pune Foods', '12 MIDC Road, Pune 411019, Maharashtra', '+91 98123 45672'),
  'https://chennai.in/': page('Chennai Works', '5 Anna Salai, Chennai 600002, Tamil Nadu', '+91 98123 45673'),
  'https://noaddr.in/': page('No Address Co', '', '+91 98123 45674'),
  'https://vague.in/': page('Vague Co', 'Some Street 12', '+91 98123 45675'),
};

describe('runs with a location filter', () => {
  const run = async (opts = {}) => {
    const r = new Runner(makeFetcher(new FakeWeb(SITES)), { location: loc(), ...opts });
    return { r, recs: await r.run(Object.keys(SITES)) };
  };

  it('exports only companies inside the imported location', async () => {
    const { r, recs } = await run();
    expect(recs.map((x) => x.business_name).sort()).toEqual(['Inside Traders', 'Pollachi Mills']);
    expect([r.stats.location_mismatch, r.stats.location_unverified, r.stats.businesses_processed]).toEqual([2, 2, 6]);
    const reasons = Object.fromEntries(r.skipped.map((x: any) => [x.business_name, x.reason]));
    expect(reasons['Pune Foods']).toMatch(/^location mismatch.*maharashtra/);
    expect(reasons['Chennai Works']).toMatch(/^location mismatch.*600002/);
    expect(reasons['No Address Co']).toMatch(/^location not verified/);
    expect(reasons['Vague Co']).toMatch(/^location not verified/);
  });

  it('every exported address matches the location', async () => {
    const { recs } = await run();
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((x) => loc().check(x.address).verdict === 'MATCH' && x.provenance.location.verdict === 'MATCH')).toBe(true);
  });

  it('allowUnknownLocation exports unplaceable companies but never foreign ones', async () => {
    const { r, recs } = await run({ allowUnknownLocation: true });
    expect(recs.map((x) => x.business_name).sort()).toEqual(['Inside Traders', 'No Address Co', 'Pollachi Mills', 'Vague Co']);
    expect(r.stats.location_mismatch).toBe(2);
  });

  it('reads contact pages to find an address when a filter is active', async () => {
    const web = new FakeWeb({
      'https://shop.in/': "<html><head><title>Shop Co</title></head><body><a href='tel:+919812345670'>c</a></body></html>",
      'https://shop.in/contact-us': '<html><body><address>3 Cross Cut Road, Coimbatore 641012</address></body></html>',
    });
    const recs = await new Runner(makeFetcher(web), { location: loc() }).run(['https://shop.in/']);
    expect(recs).toHaveLength(1);
    expect(recs[0].address).toBe('3 Cross Cut Road, Coimbatore 641012');
  });

  it('changes nothing without a filter', async () => {
    const r = new Runner(makeFetcher(new FakeWeb(SITES)));
    expect(await r.run(Object.keys(SITES))).toHaveLength(6);
    expect(r.stats.location_mismatch).toBe(0);
  });
});
