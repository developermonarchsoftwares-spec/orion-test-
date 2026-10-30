import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Phase 28: guards for the gateway's request/response contract. The handlers live in one large route file that needs a running
 * server and a database to execute, so these are source-level checks that keep the fixes in place; the behaviour itself was checked
 * over HTTP against a built server and a disposable database (docs/API_CONTRACT_REVIEW.md, section 6).
 */
const root = path.resolve(import.meta.dirname, '..', '..');
// Source is compared as text with "\n" in the snippets below; a Windows checkout (core.autocrlf) holds "\r\n", so line endings are normalised
const readSource = (...segments: string[]) => fs.readFileSync(path.join(root, ...segments), 'utf8').replace(/\r\n/g, '\n');
const route = readSource('app', 'api', 'v1', '[...path]', 'route.ts');
const db = readSource('lib', 'db.ts');

describe('gateway contract guards (Phase 28)', () => {
  it('every body is read through readJson: a body of null, a number or a string never reaches a handler as such', () => {
    const bare = route.match(/await req\.json\(\)/g) ?? [];
    assert.equal(bare.length, 1, 'only readJson itself may call req.json()');
    assert.match(route, /async function readJson\(req: NextRequest\)[\s\S]{0,200}typeof v === 'object' \? v : \{\}/);
  });

  it('all five method exports go through the guard that turns a thrown error into a JSON answer', () => {
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.match(route, new RegExp(`export async function ${m}\\(req: NextRequest, context[^)]*\\)[^{]*\\{\\s*return guarded\\(req, context\\);`));
    }
    assert.doesNotMatch(route, /export async function (GET|POST|PUT|PATCH|DELETE)\([^)]*\)[^{]*\{\s*return proxyRequest/);
  });

  it('customer-facing writes to the users table are strict: a refused write is an error, never "success"', () => {
    for (const needle of ['queryDbStrict(\n      `INSERT INTO users (id, email, password_hash', 'const rows = await queryDbStrict(\n    `UPDATE users']) {
      assert.ok(route.includes(needle), `missing strict write: ${needle.slice(0, 40)}`);
    }
  });

  it('a driver error is logged by code and constraint only (its detail holds the offending values) and a strict write throws only the code', () => {
    assert.doesNotMatch(db, /console\.error\('\[Database Query Error\]', err\)/);
    assert.match(db, /class DbWriteError/);
    assert.match(db, /code: e\?\.code, table: e\?\.table/);
  });

  it('the offline stand-ins for saved leads and searches do not answer a write with success', () => {
    assert.match(route, /\(fullPath === 'saved-leads' \|\| fullPath === 'saved-searches'\) && req\.method !== 'GET'[\s\S]{0,400}status: 503/);
  });

  it('the offline unlock-status query compares both sides as text (it compared uuid with text and always failed)', () => {
    assert.match(route, /business_id::text = \$2::text/);
    assert.doesNotMatch(route, /business_id = \$2 OR business_id::text = \$2/);
  });
});
