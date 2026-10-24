// Starts the API or the web app for the browser tests against the disposable `orion_e2e` database (never `orion_db`).
// The connection details (host, user, password) come from apps/api/.env; only the database name is replaced, and nothing is printed.
//   node tests/fixtures/start-e2e-server.cjs api   -> NestJS API with NODE_ENV=test and its mail webhook pointed at the local mail sink
//   node tests/fixtures/start-e2e-server.cjs web   -> Next.js app (and its gateway) on the same database, forwarding to that API
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(root, 'apps', 'api', '.env') });

const which = process.argv[2];
if (!['api', 'web'].includes(which)) {
  console.error('usage: start-e2e-server.cjs <api|web>');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set in apps/api/.env; it supplies the local server credentials.');
  process.exit(2);
}

const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
  console.error('The browser tests only run against a local database server.');
  process.exit(2);
}
url.pathname = '/orion_e2e';

const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  DB_NAME: 'orion_e2e',
  ORION_ALLOWED_LOCAL_DATABASES: 'orion_e2e',
};
let args;
// apps/api/.env sets PORT=4000; Next.js honours PORT too, so every server gets its own explicitly.
env.PORT = which === 'api' ? '4000' : '3000';
if (which === 'api') {
  Object.assign(env, {
    NODE_ENV: 'test', // enables the fixed admin sign-in code (123456), only honoured for a local database
    MAIL_TRANSPORT: 'webhook',
    MAIL_WEBHOOK_URL: `http://127.0.0.1:${process.env.MAIL_CAPTURE_PORT || 4455}/mail`,
  });
  args = ['--prefix', 'apps/api', 'run', 'start:dev'];
} else {
  Object.assign(env, { ORION_API_URL: 'http://127.0.0.1:4000' });
  args = ['--prefix', 'ownus', 'run', 'dev'];
}

const child = spawn('npm', args, { cwd: root, env, stdio: 'inherit', shell: true });
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
