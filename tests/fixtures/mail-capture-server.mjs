// Local mail sink for the browser tests. The API runs with MAIL_TRANSPORT=webhook MAIL_WEBHOOK_URL=http://127.0.0.1:<port>/mail, so every
// verification e-mail lands here instead of going to a real mailbox. Tests read the 6-digit code with GET /otp?email=<address>.
// Listens on loopback only; keeps mails in memory only; never writes them to disk.
import http from 'node:http';

const PORT = Number(process.env.MAIL_CAPTURE_PORT || 4455);
/** @type {Map<string, {code: string|null, subject: string, at: number}>} latest mail per recipient */
const latest = new Map();

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/mail') {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 200_000) req.destroy();
      });
      req.on('end', () => {
        try {
          const mail = JSON.parse(raw);
          const to = String(mail.to || '').trim().toLowerCase();
          const code = /(?<!\d)(\d{6})(?!\d)/.exec(String(mail.text || ''))?.[1] ?? null;
          if (to) latest.set(to, { code, subject: String(mail.subject || ''), at: Date.now() });
          send(res, 200, { ok: true });
        } catch {
          send(res, 400, { ok: false });
        }
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/otp') {
      const mail = latest.get((url.searchParams.get('email') || '').trim().toLowerCase());
      return mail?.code ? send(res, 200, { code: mail.code, at: mail.at }) : send(res, 404, { error: 'no code yet' });
    }
    return send(res, 404, { error: 'not found' });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`mail capture listening on http://127.0.0.1:${PORT}`));
