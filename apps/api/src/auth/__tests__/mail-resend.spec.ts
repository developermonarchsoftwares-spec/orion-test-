import { MailService, resendSender } from '../mail/mail.service';

describe('resend mail transport', () => {
  const saved = { transport: process.env.MAIL_TRANSPORT, key: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM_EMAIL };
  const realFetch = global.fetch;
  const mail = { to: 'new.user@example.com', subject: 'Orion: your verification code', text: 'Your code is 123456', sensitive: true };

  beforeEach(() => {
    process.env.MAIL_TRANSPORT = 'resend';
    process.env.RESEND_API_KEY = 're_test_key_for_unit_test';
    process.env.RESEND_FROM_EMAIL = 'security@monarchsoftwares.com';
  });

  afterEach(() => {
    global.fetch = realFetch;
    for (const [k, v] of [['MAIL_TRANSPORT', saved.transport], ['RESEND_API_KEY', saved.key], ['RESEND_FROM_EMAIL', saved.from]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('posts the message to Resend with the bearer key and the formatted sender, and reports it as delivered', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as never;

    expect(await new MailService({} as never).sendChecked(mail)).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.authorization).toBe('Bearer re_test_key_for_unit_test');
    expect(JSON.parse(init.body)).toMatchObject({ from: 'Monarch Security <security@monarchsoftwares.com>', to: ['new.user@example.com'], subject: mail.subject, text: mail.text });
  });

  it('logs the provider message id (never the recipient or the body) so a delivery can be traced', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'msg_abc123' }) }) as never;
    const log = jest.spyOn(require('@nestjs/common').Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      expect(await new MailService({} as never).sendChecked(mail)).toBe(true);
      const line = String(log.mock.calls.map((c) => c[0]).find((m) => String(m).includes('[mail:resend]')));
      expect(line).toContain('id=msg_abc123');
      expect(line).not.toContain('new.user@example.com');
      expect(line).not.toContain('123456');
    } finally {
      log.mockRestore();
    }
  });

  it('still reports delivered when the provider answer has no readable body', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('empty'); } }) as never;
    expect(await new MailService({} as never).sendChecked(mail)).toBe(true);
  });

  it('reports a refused send as not delivered, without throwing', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 }) as never;
    expect(await new MailService({} as never).sendChecked(mail)).toBe(false);
  });

  it('reports a network failure as not delivered', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as never;
    expect(await new MailService({} as never).sendChecked(mail)).toBe(false);
  });

  it('is not delivered when the API key is missing, and sends nothing', async () => {
    delete process.env.RESEND_API_KEY;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    expect(await new MailService({} as never).sendChecked(mail)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('formats the sender', () => {
    expect(resendSender({ RESEND_FROM_EMAIL: 'a@b.com' } as never)).toBe('Monarch Security <a@b.com>');
    expect(resendSender({ RESEND_FROM_EMAIL: 'Team <a@b.com>' } as never)).toBe('Team <a@b.com>');
    expect(resendSender({} as never)).toBe('Monarch Security <security@monarchsoftwares.com>');
  });
});
