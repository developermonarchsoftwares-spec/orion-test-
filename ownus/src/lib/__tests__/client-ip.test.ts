import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trustedForwardedFor, headersForApi } from '../client-ip.ts';

test('headersForApi replaces a spoofed X-Forwarded-For with the platform address and keeps other headers', () => {
  const out = headersForApi(new Headers({ 'x-forwarded-for': '9.9.9.9', 'x-vercel-forwarded-for': '203.0.113.7', authorization: 'Bearer t' }));
  assert.equal(out.get('x-forwarded-for'), '203.0.113.7');
  assert.equal(out.get('authorization'), 'Bearer t');
});

test('headersForApi leaves headers alone outside Vercel (no platform header)', () => {
  const out = headersForApi(new Headers({ 'x-forwarded-for': '9.9.9.9' }));
  assert.equal(out.get('x-forwarded-for'), '9.9.9.9');
});

const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });

test('uses the platform-set client address, ignoring a spoofed X-Forwarded-For', () => {
  assert.equal(trustedForwardedFor(h({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '1.2.3.4' })), '203.0.113.7');
});

test('takes only the first address of a list and accepts IPv6', () => {
  assert.equal(trustedForwardedFor(h({ 'x-vercel-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7');
  assert.equal(trustedForwardedFor(h({ 'x-vercel-forwarded-for': '2001:db8::1' })), '2001:db8::1');
});

test('refuses anything that is not an address, and returns null without the platform header', () => {
  assert.equal(trustedForwardedFor(h({ 'x-vercel-forwarded-for': 'evil.example; drop' })), null);
  assert.equal(trustedForwardedFor(h({ 'x-vercel-forwarded-for': '' })), null);
  assert.equal(trustedForwardedFor(h({ 'x-forwarded-for': '1.2.3.4' })), null);
});
