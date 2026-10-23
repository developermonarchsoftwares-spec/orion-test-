/**
 * Location filter: only companies located inside the imported location(s) may reach the results. Port of business_scraper/location.py.
 *
 *   MATCH      the address contains an allowed city, or a PIN code in an allowed PIN area (first three digits), or the allowed state when
 *              the place list is state-only, and nothing contradicts it
 *   MISMATCH   the address names another Indian state, or carries a PIN code outside the imported PIN areas
 *   UNKNOWN    no address, or no recognisable city / PIN / state. Never guessed from the name, phone prefix or domain.
 */
import { readFileSync } from 'node:fs';

export const INDIAN_STATES = [
  'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar', 'chhattisgarh', 'goa', 'gujarat', 'haryana', 'himachal pradesh', 'jharkhand',
  'karnataka', 'kerala', 'madhya pradesh', 'maharashtra', 'manipur', 'meghalaya', 'mizoram', 'nagaland', 'odisha', 'orissa', 'punjab',
  'rajasthan', 'sikkim', 'tamil nadu', 'tamilnadu', 'telangana', 'tripura', 'uttar pradesh', 'uttarakhand', 'uttaranchal', 'west bengal',
  'andaman and nicobar islands', 'andaman & nicobar', 'chandigarh', 'dadra and nagar haveli', 'daman and diu', 'delhi', 'new delhi',
  'jammu and kashmir', 'jammu & kashmir', 'ladakh', 'lakshadweep', 'puducherry', 'pondicherry',
];
const STATE_CANON: Record<string, string> = {
  tamilnadu: 'tamil nadu', orissa: 'odisha', uttaranchal: 'uttarakhand', pondicherry: 'puducherry', 'new delhi': 'delhi',
  'andaman & nicobar': 'andaman and nicobar islands', 'jammu & kashmir': 'jammu and kashmir',
};
const PIN_RE_G = /(?<!\d)([1-9]\d{5})(?!\d)/g;
const PIN_FULL = /^(?<!\d)[1-9]\d{5}(?!\d)$/;
const CITY_HEADERS = ['city', 'town', 'location', 'place', 'district'];
const STATE_HEADERS = ['state', 'province', 'region'];
const PIN_HEADERS = ['pincode', 'pin code', 'pin', 'postal code', 'postcode', 'zip', 'zipcode', 'zip code'];

export class LocationError extends Error {}

/** Lower-case, accents removed, punctuation to spaces: 'Tiruppur ' == 'tiruppur', 'Pondé' == 'ponde'. */
export function norm(text: unknown): string {
  const t = String(text ?? '').normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase();
  return t.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function canonState(name: string): string {
  const n = norm(name);
  return STATE_CANON[n] ?? n;
}

export interface Place {
  cities: Set<string>;
  state: string | null;
}

export interface Verdict {
  verdict: 'MATCH' | 'MISMATCH' | 'UNKNOWN';
  reason: string;
  evidence?: Record<string, unknown>;
}

const KNOWN_STATES = new Set(INDIAN_STATES.map(canonState));

/** Minimal RFC-4180 CSV reader (quotes, escaped quotes, CRLF) returning rows of cells. */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

export class LocationSet {
  places: Place[] = [];
  pincodes = new Set<string>();

  get pinAreas(): Set<string> {
    return new Set([...this.pincodes].map((p) => p.slice(0, 3)));
  }

  get states(): Set<string> {
    return new Set(this.places.map((p) => p.state).filter((s): s is string => !!s));
  }

  isEmpty(): boolean {
    return !this.places.length && !this.pincodes.size;
  }

  describe(): string {
    const cities = [...new Set(this.places.flatMap((p) => [...p.cities]))].sort();
    const parts: string[] = [];
    if (cities.length) parts.push('places: ' + cities.slice(0, 12).join(', ') + (cities.length > 12 ? ' ...' : ''));
    if (this.states.size) parts.push('states: ' + [...this.states].sort().join(', '));
    if (this.pinAreas.size) parts.push('PIN areas: ' + [...this.pinAreas].sort().join(', '));
    return parts.join('; ');
  }

  addPlace(city?: string | null, state?: string | null, pincode?: string | null): void {
    const cities = new Set((city ?? '').split('|').map(norm).filter(Boolean));
    const st = state && norm(state) ? canonState(state) : null;
    if (cities.size || st) {
      const existing = this.places.find((p) => p.state === st);
      if (existing) cities.forEach((c) => existing.cities.add(c));
      else this.places.push({ cities, state: st });
    }
    if (pincode) for (const m of String(pincode).matchAll(PIN_RE_G)) this.pincodes.add(m[1]);
  }

  /** 'Coimbatore, Tamil Nadu' | 'Pollachi|Pollachchi' | 'Tamil Nadu' | '641008' | 'Coimbatore, Tamil Nadu, 641008'. */
  addText(text: string): void {
    const parts = String(text).split(',').map((p) => p.trim()).filter(Boolean);
    const pins = parts.filter((p) => PIN_FULL.test(p));
    const rest = parts.filter((p) => !pins.includes(p));
    let city: string | undefined;
    let state: string | undefined;
    if (rest.length === 1) {
      if (KNOWN_STATES.has(canonState(rest[0]))) state = rest[0];
      else city = rest[0];
    } else if (rest.length === 2) {
      [city, state] = rest;
      if (!KNOWN_STATES.has(canonState(state))) {
        throw new LocationError(`cannot read location '${text}': '${state}' is not an Indian state (write 'City, State', for example 'Coimbatore, Tamil Nadu')`);
      }
    } else if (rest.length > 2) {
      throw new LocationError(`cannot read location '${text}': use 'City, State' with an optional PIN code`);
    }
    for (const name of [city, state]) {
      if (name && !/[A-Za-z]{2}/.test(name)) throw new LocationError(`cannot read location '${text}': '${name}' is not a place name`);
    }
    if (!city && !state && !pins.length) throw new LocationError(`cannot read location '${text}'`);
    pins.forEach((p) => this.pincodes.add(p));
    if (city || state) this.addPlace(city, state);
  }

  /** Reads city / state / pincode columns from a CSV, or a plain list of locations, one per line. */
  static fromCsv(path: string, maxRows = 200000): LocationSet {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8').replace(/^﻿/, '');
    } catch (err) {
      throw new LocationError(`cannot read '${path}': ${(err as Error).message}`);
    }
    return LocationSet.fromCsvText(raw, path, maxRows);
  }

  static fromCsvText(raw: string, label = 'input', maxRows = 200000): LocationSet {
    const first = raw.split(/\r?\n/, 1)[0] ?? '';
    const headerCells = new Set(first.split(/[,;\t]/).map(norm));
    const ls = new LocationSet();
    if (![...CITY_HEADERS, ...STATE_HEADERS, ...PIN_HEADERS].some((h) => headerCells.has(h))) {
      for (const line of raw.split(/\r?\n/)) {
        if (line.trim() && !line.trimStart().startsWith('#')) ls.addText(line.trim());
      }
      if (ls.isEmpty()) throw new LocationError(`no locations found in '${label}'`);
      return ls;
    }
    const count = (c: string) => first.split(c).length - 1;
    const rows = parseCsv(raw, count(';') > count(',') ? ';' : ',');
    const headers = new Map(rows[0].map((h, i) => [norm(h), i] as const));
    const col = (opts: string[]) => opts.map((o) => headers.get(o)).find((i) => i !== undefined);
    const [cCity, cState, cPin] = [col(CITY_HEADERS), col(STATE_HEADERS), col(PIN_HEADERS)];
    rows.slice(1, maxRows + 1).forEach((r) => {
      ls.addPlace(cCity !== undefined ? r[cCity] : null, cState !== undefined ? r[cState] : null, cPin !== undefined ? r[cPin] : null);
    });
    if (ls.isEmpty()) throw new LocationError(`no locations found in '${label}'`);
    return ls;
  }

  check(address: string | null | undefined): Verdict {
    if (this.isEmpty()) return { verdict: 'MATCH', reason: 'no location filter' };
    const text = norm(address ?? '');
    if (!text) return { verdict: 'UNKNOWN', reason: 'no address was found, so the location cannot be validated' };
    const pins = [...(address ?? '').matchAll(PIN_RE_G)].map((m) => m[1]);
    const padded = ` ${text} `;
    const mentioned = new Set(INDIAN_STATES.filter((s) => padded.includes(` ${norm(s)} `)).map(canonState));
    const allowedStates = this.states;
    const matched = this.places.filter((p) => [...p.cities].some((c) => padded.includes(` ${c} `)));
    const ev: Record<string, unknown> = { address, pincodes_in_address: pins, states_in_address: [...mentioned].sort() };
    const areas = this.pinAreas;
    const pinInArea = (pin: string) => areas.has(pin.slice(0, 3));

    const foreign = [...mentioned].filter((s) => allowedStates.size && !allowedStates.has(s)).sort();
    if (foreign.length && !matched.some((p) => p.state === null)) {
      return { verdict: 'MISMATCH', reason: `the address names ${foreign.join(', ')}, outside the imported location`, evidence: ev };
    }
    if (pins.length && areas.size && !pins.some(pinInArea)) {
      return { verdict: 'MISMATCH', reason: `PIN code ${pins[0]} is outside the imported PIN areas (${[...areas].sort().join(', ')})`, evidence: ev };
    }
    for (const p of matched) {
      if (p.state && mentioned.size && !mentioned.has(p.state) && allowedStates.size) {
        return { verdict: 'MISMATCH', reason: `the address names ${[...mentioned].sort().join(', ')}, not ${p.state}`, evidence: ev };
      }
    }
    if (pins.length && areas.size && pins.some(pinInArea)) {
      ev.matched_by = 'pincode';
      return { verdict: 'MATCH', reason: `PIN code ${pins.find(pinInArea)} is in the imported PIN area`, evidence: ev };
    }
    if (matched.length) {
      ev.matched_by = 'city';
      const city = matched.flatMap((p) => [...p.cities].sort()).find((c) => padded.includes(` ${c} `));
      return { verdict: 'MATCH', reason: `the address names ${city}`, evidence: ev };
    }
    const stateOnly = this.places.filter((p) => !p.cities.size && p.state && mentioned.has(p.state));
    if (stateOnly.length) {
      ev.matched_by = 'state';
      return { verdict: 'MATCH', reason: `the address names ${stateOnly[0].state}`, evidence: ev };
    }
    return { verdict: 'UNKNOWN', reason: 'the address has no recognisable city, PIN code or state of the imported location', evidence: ev };
  }
}
