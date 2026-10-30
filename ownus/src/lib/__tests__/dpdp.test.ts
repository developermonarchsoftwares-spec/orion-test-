import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GRIEVANCE, LEGAL_REVIEW_PENDING, PURPOSES, RIGHTS, RIGHTS_TYPE_LABEL, THIRD_PARTIES } from '../compliance.ts';
import { EMPTY_RIGHTS_FORM, RIGHTS_TYPES, validateRightsForm } from '../rights-request.ts';
import { TRACKERS, planTrackers, type ITracker } from '../trackers.ts';
import { gateExempt, gateStateFor } from '../consent-gate.ts';

/** DPDP Act work: tracker gating, consent purposes, the rights form, and source-level checks that the pages carry the required elements. */
const src = (...p: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', ...p), 'utf8').replace(/\r\n/g, '\n');

const analyticsTracker: ITracker = { id: 'demo-analytics', purpose: 'analytics', src: 'https://example.invalid/a.js' };
const marketingTracker: ITracker = { id: 'demo-pixel', purpose: 'marketing', src: 'https://example.invalid/p.js' };
const list = [analyticsTracker, marketingTracker];
const consent = (analytics: boolean, marketing: boolean, decided = true) => ({ analytics, marketing, decided });

describe('tracker gating', () => {
  it('ships no non-essential tracker', () => {
    assert.equal(TRACKERS.length, 0);
  });
  it('loads nothing before a choice is made', () => {
    assert.deepEqual(planTrackers(consent(true, true, false), new Set(), list), { load: [], withdrawn: [] });
  });
  it('loads only the trackers whose purpose was granted', () => {
    const plan = planTrackers(consent(true, false), new Set(), list);
    assert.deepEqual(plan.load.map((t) => t.id), ['demo-analytics']);
    assert.deepEqual(plan.withdrawn, []);
  });
  it('does not load twice, and flags a loaded tracker when consent is withdrawn', () => {
    assert.deepEqual(planTrackers(consent(true, false), new Set(['demo-analytics']), list), { load: [], withdrawn: [] });
    const plan = planTrackers(consent(false, false), new Set(['demo-analytics']), list);
    assert.deepEqual(plan.withdrawn.map((t) => t.id), ['demo-analytics']);
  });
});

describe('consent purposes', () => {
  it('has unique purposes, and only the account purpose is required', () => {
    assert.equal(new Set(PURPOSES.map((p) => p.id)).size, PURPOSES.length);
    assert.deepEqual(PURPOSES.filter((p) => p.required).map((p) => p.id), ['ACCOUNT_SERVICE']);
  });
  it('the sign-up page keeps every box unticked and separate from the Terms', () => {
    const page = src('app', '(auth)', 'register', 'page.tsx');
    assert.match(page, /useState\(false\)/);
    assert.doesNotMatch(page, /defaultChecked|useState<ConsentChoices>\(\{\s*\w+:\s*true/);
    assert.match(page, /<ConsentCheckboxes/);
    // the choices travel with the sign-up request and the server writes them in the same step as the account
    assert.match(page, /consents: \{ ACCOUNT_SERVICE: true, PRODUCT_UPDATES: consents\.PRODUCT_UPDATES === true, MARKETING: consents\.MARKETING === true \}/);
    assert.doesNotMatch(page, /recordConsents\(/);
    assert.match(page, /!consents\.ACCOUNT_SERVICE/);
    const boxes = src('components', 'privacy', 'consent-checkboxes.tsx');
    assert.match(boxes, /checked=\{value\[p\.id\] === true\}/);
  });
});

describe('rights form', () => {
  const ok = { ...EMPTY_RIGHTS_FORM, type: 'ACCESS' as const, name: 'Asha Rao', email: 'asha@example.com', relationship: 'OTHER' as const, processingConsent: true };
  it('offers every DPDP right with a label', () => {
    assert.deepEqual([...RIGHTS_TYPES], ['ACCESS', 'CORRECTION', 'ERASURE', 'WITHDRAWAL', 'GRIEVANCE', 'NOMINATION']);
    for (const t of RIGHTS_TYPES) assert.ok(RIGHTS_TYPE_LABEL[t], t);
    assert.equal(RIGHTS.length, 6);
  });
  it('an empty form is refused field by field and starts with the agreement unticked', () => {
    assert.equal(EMPTY_RIGHTS_FORM.processingConsent, false);
    const e = validateRightsForm(EMPTY_RIGHTS_FORM);
    for (const k of ['type', 'name', 'email', 'relationship', 'processingConsent']) assert.ok((e as Record<string, string>)[k], k);
  });
  it('accepts a complete access request', () => {
    assert.deepEqual(validateRightsForm(ok), {});
  });
  it('corrections, grievances and nominations need a description', () => {
    for (const type of ['CORRECTION', 'GRIEVANCE', 'NOMINATION'] as const) {
      assert.ok(validateRightsForm({ ...ok, type }).details, type);
      assert.deepEqual(validateRightsForm({ ...ok, type, details: 'My employer is shown wrongly.' }), {});
    }
  });
  it('rejects a bad e-mail and over-long details', () => {
    assert.ok(validateRightsForm({ ...ok, email: 'nope' }).email);
    assert.ok(validateRightsForm({ ...ok, details: 'x'.repeat(501) }).details);
  });
});

describe('required DPDP elements are published', () => {
  it('names a grievance contact with an e-mail address', () => {
    assert.match(GRIEVANCE.email, /^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    assert.ok(GRIEVANCE.officerName.length > 0);
  });
  it('lists the third parties found in the code', () => {
    const names = THIRD_PARTIES.map((t) => t.name).join(' ');
    for (const n of ['Razorpay', 'Turnstile', 'Resend', 'R2']) assert.match(names, new RegExp(n));
  });
  it('the footer shows the grievance contact, the notice, the rights form and a way to change consent', () => {
    const footer = src('components', 'layout', 'footer.tsx');
    assert.match(footer, /GRIEVANCE\.email/);
    assert.match(footer, /\/privacy-notice/);
    assert.match(footer, /\/data-rights/);
    assert.match(footer, /PrivacyChoicesButton/);
  });
  it('the notice covers data, purposes, retention, third parties, every right and the grievance officer, and flags legal review', () => {
    const page = src('app', '(marketing)', 'privacy-notice', 'page.tsx');
    for (const id of ['id="data"', 'id="purposes"', 'id="retention"', 'id="third-parties"', 'id="rights"', 'id="grievance"']) assert.ok(page.includes(id), id);
    assert.match(page, /LEGAL_REVIEW_PENDING/);
    assert.ok(LEGAL_REVIEW_PENDING, 'flip to false only after counsel signs off');
  });
  it('the terms carry a data-protection clause', () => {
    assert.match(src('app', '(marketing)', 'terms', 'page.tsx'), /id="data-protection"/);
  });
  it('the banner can be reopened from the footer and the loader is mounted', () => {
    assert.match(src('components', 'privacy', 'consent-banner.tsx'), /orion:open-consent/);
    assert.match(src('app', 'layout.tsx'), /<TrackerLoader \/>/);
  });
});

describe('consent gate (accounts without a recorded account consent)', () => {
  it('asks when there is no record, when it was withdrawn, and not when it is granted', () => {
    assert.equal(gateStateFor({ consents: { ACCOUNT_SERVICE: { granted: true, updatedAt: '2026-10-30T00:00:00Z' } } }), 'ok');
    assert.equal(gateStateFor({ consents: { ACCOUNT_SERVICE: { granted: false, updatedAt: null } } }), 'new');
    assert.equal(gateStateFor({ consents: { ACCOUNT_SERVICE: { granted: false, updatedAt: '2026-10-30T00:00:00Z' } } }), 'withdrawn');
    assert.equal(gateStateFor({}), 'new');
    assert.equal(gateStateFor(null), 'new');
  });
  it('keeps settings reachable so a person who does not agree can export or delete their data', () => {
    assert.equal(gateExempt('/settings'), true);
    assert.equal(gateExempt('/settings/anything'), true);
    for (const p of ['/dashboard', '/discover', '/settingsx', '/credits', '', null, undefined]) assert.equal(gateExempt(p as any), false, String(p));
  });
  it('is mounted for the signed-in area, needs a ticked required box, and waits for the server before it lets go', () => {
    assert.match(src('app', '(app)', 'layout.tsx'), /<ConsentGate \/>/);
    const gate = src('components', 'privacy', 'consent-gate.tsx');
    assert.match(gate, /choices\.ACCOUNT_SERVICE !== true/);
    assert.match(gate, /const saved = await recordConsents\(/);
    assert.match(gate, /if \(!saved\)/);
    assert.match(gate, /catch \{\s*setState\("ok"\)/, 'a failed lookup must not lock people out');
  });
  it('the settings panel lists the account consent and warns before withdrawing it', () => {
    const panel = src('components', 'privacy', 'privacy-panel.tsx');
    assert.match(panel, /id: "ACCOUNT_SERVICE"/);
    assert.match(panel, /window\.confirm\("Withdrawing this consent will schedule your account for deletion/);
  });
});

describe('erasure confirmation page', () => {
  const page = src('components', 'privacy', 'confirm-erasure.tsx');
  it('reads the secret from the URL fragment, removes it from the address bar and sends it only on a click', () => {
    assert.match(page, /window\.location\.hash/);
    assert.match(page, /history\.replaceState/);
    assert.match(page, /onClick=\{\(\) => void confirm\(\)\}/);
    assert.doesNotMatch(page, /useEffect\([^)]*confirm\(\)/, 'no automatic confirmation on load');
    assert.match(page, /\/privacy-requests\/verify/);
  });
});
