import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSavedFilters, applySavedFilters } from '../saved-search-summary.ts';

const base = { state: '', cities: [] as string[], minScore: 0, hasWebsite: false };

test('applySavedFilters takes known keys of the right kind and nothing else', () => {
  const out = applySavedFilters(base, { state: 'Telangana', cities: ['Hyderabad'], minScore: 80, hasWebsite: true, unknownKey: 'x' });
  assert.deepEqual(out, { state: 'Telangana', cities: ['Hyderabad'], minScore: 80, hasWebsite: true });
  assert.ok(!('unknownKey' in out));
});

test('applySavedFilters ignores values of the wrong kind and bad input, and never changes the defaults it was given', () => {
  assert.deepEqual(applySavedFilters(base, { state: ['x'], cities: 'Hyderabad', minScore: '80', hasWebsite: 'yes' }), base);
  for (const bad of [null, undefined, 'x', 5, ['a']]) assert.deepEqual(applySavedFilters(base, bad), base);
  applySavedFilters(base, { state: 'Kerala' });
  assert.equal(base.state, '');
});

test('describes the filters that are really set, in plain words', () => {
  assert.equal(describeSavedFilters({ city: 'Hyderabad', state: 'Telangana' }), '2 filters: city, state');
  assert.equal(describeSavedFilters({ industry: 'Retail' }), '1 filter: industry');
  assert.equal(describeSavedFilters({ minOrionScore: 80, hasWebsite: true }), '2 filters: min orion score, has website');
});

test('empty, false and blank values are not counted, and an empty search says so', () => {
  assert.equal(describeSavedFilters({ city: '', states: [], hasWebsite: false, x: null, y: undefined, z: {} }), 'All businesses (no filters)');
  assert.equal(describeSavedFilters({}), 'All businesses (no filters)');
});

test('anything that is not an object is reported honestly, and long lists are cut short', () => {
  for (const bad of [null, undefined, 'x', 5]) assert.equal(describeSavedFilters(bad), 'No filters saved');
  assert.equal(describeSavedFilters({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }), '6 filters: a, b, c, d, ...');
});
