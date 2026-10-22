import { HttpStatus } from '@nestjs/common';
import { CRON_JOBS, CronController, cronAuthorized } from './cron.controller';
import { QueueService } from '../queue/queue.service';
import { backgroundJobDisabled, serverlessRuntime } from '../../common/utils/restore-mode';

const SECRET = 'c'.repeat(40);

describe('Vercel Cron routes', () => {
  const saved = { secret: process.env.CRON_SECRET, restore: process.env.RESTORE_MODE };
  afterEach(() => {
    for (const [k, v] of [['CRON_SECRET', saved.secret], ['RESTORE_MODE', saved.restore]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const req = (authorization?: string) => ({ headers: { authorization } }) as any;
  const status = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as any)?.getStatus?.();

  it('cronAuthorized needs the exact bearer secret and a secret of 32+ characters', () => {
    expect(cronAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(cronAuthorized(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(cronAuthorized(`Bearer ${'d'.repeat(40)}`, SECRET)).toBe(false);
    expect(cronAuthorized(SECRET, SECRET)).toBe(false);
    expect(cronAuthorized(undefined, SECRET)).toBe(false);
    expect(cronAuthorized('Bearer short', 'short')).toBe(false); // too short to be a secret
    expect(cronAuthorized('Bearer ', '')).toBe(false);
  });

  it('is closed (503) without a configured secret, 401 with a wrong one, 404 for an unknown job', async () => {
    const c = new CronController({ get: jest.fn() } as any);
    delete process.env.CRON_SECRET;
    expect(await status(c.run('exports', req(`Bearer ${SECRET}`)))).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    process.env.CRON_SECRET = SECRET;
    expect(await status(c.run('exports', req()))).toBe(HttpStatus.UNAUTHORIZED);
    expect(await status(c.run('exports', req('Bearer nope')))).toBe(HttpStatus.UNAUTHORIZED);
    expect(await status(c.run('nothing', req(`Bearer ${SECRET}`)))).toBe(HttpStatus.NOT_FOUND);
  });

  it('runs nothing in restore mode, and runs the named job otherwise', async () => {
    process.env.CRON_SECRET = SECRET;
    const get = jest.fn();
    const queue = { drain: jest.fn().mockResolvedValue({ queues: 2 }) };
    get.mockReturnValue(queue);
    const c = new CronController({ get } as any);
    process.env.RESTORE_MODE = 'true';
    expect(await c.run('queues', req(`Bearer ${SECRET}`))).toEqual({ job: 'queues', skipped: 'RESTORE_MODE' });
    expect(queue.drain).not.toHaveBeenCalled();
    delete process.env.RESTORE_MODE;
    const r: any = await c.run('queues', req(`Bearer ${SECRET}`));
    expect(get).toHaveBeenCalledWith(QueueService, { strict: false });
    expect(r).toMatchObject({ job: 'queues', ok: true, result: { queues: 2 } });
  });

  it('every job has a case that runs it', async () => {
    process.env.CRON_SECRET = SECRET;
    const svc: any = { runDailyRollover: jest.fn(), tick: jest.fn().mockResolvedValue({ attempted: 0, succeeded: 0, purged: 0 }), run: jest.fn(), purgeStaleTokens: jest.fn().mockResolvedValue(1), drain: jest.fn(), prune: jest.fn() };
    const c = new CronController({ get: () => svc } as any);
    for (const job of CRON_JOBS) expect(await c.run(job, req(`Bearer ${SECRET}`))).toMatchObject({ job, ok: true });
  });

  it('on Vercel the in-process timers are off unless FORCE_BACKGROUND_JOBS=true', () => {
    expect(serverlessRuntime({ VERCEL: '1' } as any)).toBe(true);
    expect(serverlessRuntime({} as any)).toBe(false);
    expect(serverlessRuntime({ VERCEL: '1', FORCE_BACKGROUND_JOBS: 'true' } as any)).toBe(false);
    expect(backgroundJobDisabled('DISABLE_X', { VERCEL: '1' } as any)).toBe(true);
    expect(backgroundJobDisabled('DISABLE_X', {} as any)).toBe(false);
  });
});
