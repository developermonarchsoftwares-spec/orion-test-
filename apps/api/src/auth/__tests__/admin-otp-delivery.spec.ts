import { ServiceUnavailableException } from '@nestjs/common';
import { AdminAuthController } from '../admin-auth.controller';
import { buildAdminOtpMail } from '../mail/admin-otp.mail';

/** Admin sign-in codes must actually be e-mailed by the API: in production the web gateway forwards the request here and sends nothing itself. */
describe('administrator sign-in code delivery', () => {
  const ADMIN = 'admin@monarchsoftwares.com';
  const req = { ip: '203.0.113.7', headers: { 'user-agent': 'jest' } } as never;
  const saved = { n: process.env.NODE_ENV, d: process.env.DATABASE_URL };
  // a code is e-mailed everywhere except local automated tests (NODE_ENV=test with a local database), so run as a hosted environment
  beforeAll(() => { process.env.NODE_ENV = 'production'; process.env.DATABASE_URL = 'postgresql://u:p@db.example.com:5432/app'; });
  afterAll(() => { process.env.NODE_ENV = saved.n; if (saved.d === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.d; });

  const build = (delivered: boolean, opts: { insertFails?: boolean } = {}) => {
    const inserted: any[] = [];
    const deleted: any[] = [];
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      delete: () => ({ where: (w: unknown) => { deleted.push(w); return Object.assign(Promise.resolve(), { catch: () => Promise.resolve() }); } }),
      insert: () => ({ values: async (v: unknown) => { if (opts.insertFails) throw new Error('db down'); inserted.push(v); } }),
    };
    const mail = { sendChecked: jest.fn().mockResolvedValue(delivered) };
    const users = { findByEmail: jest.fn().mockResolvedValue({ status: 'ACTIVE', role: 'ADMIN' }) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new AdminAuthController(users as never, {} as never, db as never, audit as never, mail as never);
    return { controller, mail, inserted, deleted, audit };
  };

  it('stores the code and e-mails exactly that code to the administrator', async () => {
    const { controller, mail, inserted } = build(true);
    const res: any = await controller.sendOtp({ email: ADMIN } as never, req);
    expect(res.success).toBe(true);
    expect(res.data.previewOtp).toBeUndefined();
    expect(inserted).toHaveLength(1);
    const sent = mail.sendChecked.mock.calls[0][0];
    expect(sent.to).toBe(ADMIN);
    expect(sent.sensitive).toBe(true);
    const code = /\b(\d{6})\b/.exec(sent.text)?.[1];
    expect(code).toBeTruthy();
    expect(inserted[0].otp).not.toBe(code); // only a keyed hash is stored, never the code
  });

  it('a failed send removes the stored code and says so, instead of claiming a code was sent', async () => {
    const { controller, deleted, audit } = build(false);
    await expect(controller.sendOtp({ email: ADMIN } as never, req)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(deleted.length).toBeGreaterThanOrEqual(2); // the clean-up before storing, and the removal after the failed send
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'ADMIN_OTP_SEND_FAILED' }));
  });

  it('does not e-mail a code that could not be stored', async () => {
    const { controller, mail } = build(true, { insertFails: true });
    await expect(controller.sendOtp({ email: ADMIN } as never, req)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(mail.sendChecked).not.toHaveBeenCalled();
  });

  it('an address that is not an administrator gets the same answer and no e-mail', async () => {
    const { controller, mail } = build(true);
    (controller as any).userRepository.findByEmail = jest.fn().mockResolvedValue(undefined);
    const res: any = await controller.sendOtp({ email: 'nobody@monarchsoftwares.com' } as never, req);
    expect(res.success).toBe(true);
    expect(mail.sendChecked).not.toHaveBeenCalled();
  });

  it('the message names the admin console, shows a spaced code and never logs its body', () => {
    const m = buildAdminOtpMail(ADMIN, '123456', 5);
    expect(m.subject).toMatch(/admin/i);
    expect(m.text).toContain('123456');
    expect(m.html).toContain('123 456');
    expect(m.sensitive).toBe(true);
  });
});
