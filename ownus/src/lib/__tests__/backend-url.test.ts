import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendBaseUrl, hasRemoteBackend, describeBackendTarget, DEFAULT_LOCAL_BACKEND } from '../backend-url.ts';

test('describeBackendTarget reports the source and flags a hosted deployment that fell back to localhost', () => {
  assert.deepEqual(describeBackendTarget({ ORION_API_URL: 'https://api-x.vercel.internal' }), { source: 'service-binding', host: 'api-x.vercel.internal', misconfigured: false });
  assert.deepEqual(describeBackendTarget({ BACKEND_API_URL: 'https://api.example.com/api/v1' }), { source: 'BACKEND_API_URL', host: 'api.example.com', misconfigured: false });
  assert.equal(describeBackendTarget({ VERCEL: '1' }).misconfigured, true);
  assert.equal(describeBackendTarget({ NODE_ENV: 'production' }).source, 'default-local');
  assert.equal(describeBackendTarget({}).misconfigured, false); // plain local development
  assert.equal(describeBackendTarget({ VERCEL: '1', BACKEND_API_URL: 'http://localhost:4000/api/v1' }).misconfigured, true);
});

test('a Vercel service binding wins and gets the API prefix appended', () => {
  const env = { ORION_API_URL: 'https://api-abc.vercel.internal/', BACKEND_API_URL: 'http://localhost:4000/api/v1' };
  assert.equal(backendBaseUrl(env), 'https://api-abc.vercel.internal/api/v1');
  assert.equal(hasRemoteBackend(env), true);
});

test('without a binding, BACKEND_API_URL is used as given (already includes the prefix), trailing slash removed', () => {
  assert.equal(backendBaseUrl({ BACKEND_API_URL: 'https://api.example.com/api/v1/' }), 'https://api.example.com/api/v1');
  assert.equal(backendBaseUrl({ NEST_API_URL: 'https://old.example.com/api/v1' }), 'https://old.example.com/api/v1');
});

test('with nothing configured it falls back to the local API', () => {
  assert.equal(backendBaseUrl({}), DEFAULT_LOCAL_BACKEND);
  assert.equal(backendBaseUrl({ ORION_API_URL: '   ' }), DEFAULT_LOCAL_BACKEND);
});

test('a local BACKEND_API_URL is not treated as a remote backend; a remote one is', () => {
  assert.equal(hasRemoteBackend({}), false);
  assert.equal(hasRemoteBackend({ BACKEND_API_URL: 'http://127.0.0.1:4000/api/v1' }), false);
  assert.equal(hasRemoteBackend({ BACKEND_API_URL: 'http://localhost:4000/api/v1' }), false);
  assert.equal(hasRemoteBackend({ BACKEND_API_URL: 'https://api.example.com/api/v1' }), true);
});
