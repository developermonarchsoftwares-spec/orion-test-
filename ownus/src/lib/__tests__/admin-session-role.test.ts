import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleFromToken, canAccessRoles } from '../admin-session-role.ts';

const token = (payload: object) => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

test('reads the role claim from an admin token', () => {
  assert.equal(roleFromToken(token({ sub: 'u', role: 'SUPER_ADMIN' })), 'SUPER_ADMIN');
  assert.equal(roleFromToken(token({ sub: 'u', role: 'ADMIN' })), 'ADMIN');
  assert.equal(roleFromToken(token({ sub: 'u', role: 'DATA_MANAGER' })), 'DATA_MANAGER');
});

test('anything that is not a clearly valid admin role gives null', () => {
  for (const t of [null, undefined, '', 'abc', 'a.b', 'a.b.c.d', token({ role: 'USER' }), token({ role: 'super_admin' }), token({ role: 5 }), token({}), token({ role: ['SUPER_ADMIN'] })]) {
    assert.equal(roleFromToken(t as any), null, String(t));
  }
});

test('only a SUPER_ADMIN may open Roles & Permissions; every other role and every unknown is denied', () => {
  assert.equal(canAccessRoles('SUPER_ADMIN'), true);
  for (const r of ['ADMIN', 'DATA_MANAGER', null, undefined] as const) assert.equal(canAccessRoles(r), false, String(r));
});

test('a customer-style or tampered token never grants access', () => {
  assert.equal(canAccessRoles(roleFromToken(token({ role: 'USER' }))), false);
  assert.equal(canAccessRoles(roleFromToken(token({ role: 'SUPER_ADMIN ' }))), false);
  assert.equal(canAccessRoles(roleFromToken('not-a-token')), false);
});
