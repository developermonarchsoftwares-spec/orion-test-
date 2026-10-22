import { Controller, Get, HttpStatus, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ModuleRef } from '@nestjs/core';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { Public } from '../../auth/decorators';
import { BusinessException } from '../../common/errors/business.exception';
import { restoreMode } from '../../common/utils/restore-mode';
import { AuthService } from '../../auth/services/auth.service';
import { CreditScheduler } from '../credit/credit.scheduler';
import { ExportSchedulerService } from '../export/export-scheduler.service';
import { WebhookDispatcherService } from '../integrations/webhook-dispatcher.service';
import { PrivacyScheduler } from '../privacy/privacy.scheduler';
import { QueueService } from '../queue/queue.service';

/** Longest a webhook pass keeps going inside one cron call (Vercel Cron cannot fire more often than once a minute). */
const WEBHOOK_BUDGET_MS = 45_000;
const MIN_SECRET_LENGTH = 32;

export const CRON_JOBS = ['credit-rollover', 'exports', 'webhooks', 'privacy', 'token-cleanup', 'queues', 'queue-prune'] as const;
export type CronJob = (typeof CRON_JOBS)[number];

/** True when the Authorization header is `Bearer <CRON_SECRET>` (the header Vercel Cron sends when CRON_SECRET is set). Constant time. */
export function cronAuthorized(authorization: string | undefined, secret = process.env.CRON_SECRET ?? ''): boolean {
  if (secret.length < MIN_SECRET_LENGTH) return false;
  const given = /^Bearer\s+(.+)$/i.exec(String(authorization ?? ''))?.[1] ?? '';
  return given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

/**
 * Runs the background jobs that used to be in-process timers. On Vercel those timers are off (restore-mode.ts: serverlessRuntime) and
 * Vercel Cron calls these routes (schedule in the root vercel.json). Every route needs CRON_SECRET; without a secret of 32+ characters the
 * routes are closed (503). Each job is already safe to run on several instances and to overlap (claims and locks live in the services).
 */
@ApiTags('Cron')
@Controller('cron')
export class CronController {
  constructor(private readonly moduleRef: ModuleRef) {}

  private get<T>(type: new (...args: any[]) => T): T {
    return this.moduleRef.get(type, { strict: false });
  }

  @Public() // authenticated by CRON_SECRET, like /metrics by METRICS_TOKEN
  @Get(':job')
  @ApiOperation({ summary: 'Vercel Cron: run one background job. Needs `Authorization: Bearer $CRON_SECRET`.' })
  async run(@Param('job') job: string, @Req() req: Request) {
    if ((process.env.CRON_SECRET ?? '').length < MIN_SECRET_LENGTH) {
      throw new BusinessException('Cron is not configured', 'CRON_NOT_CONFIGURED', HttpStatus.SERVICE_UNAVAILABLE);
    }
    if (!cronAuthorized(req.headers.authorization)) throw new BusinessException('A valid cron secret is required', 'UNAUTHORIZED', HttpStatus.UNAUTHORIZED);
    if (!(CRON_JOBS as readonly string[]).includes(job)) throw new BusinessException('Unknown cron job', 'NOT_FOUND', HttpStatus.NOT_FOUND);
    // a restored database must not have its old jobs started before the restore is verified (restore-mode.ts)
    if (restoreMode()) return { job, skipped: 'RESTORE_MODE' };

    const started = Date.now();
    let result: unknown;
    switch (job as CronJob) {
      case 'credit-rollover':
        await this.get(CreditScheduler).runDailyRollover();
        break;
      case 'exports':
        result = await this.get(ExportSchedulerService).tick();
        break;
      case 'webhooks': {
        const dispatcher = this.get(WebhookDispatcherService);
        let attempted = 0;
        let succeeded = 0;
        let purged = 0;
        while (Date.now() - started < WEBHOOK_BUDGET_MS) {
          const r = await dispatcher.tick();
          attempted += r.attempted;
          succeeded += r.succeeded;
          purged += r.purged;
          if (!r.attempted) break;
        }
        result = { attempted, succeeded, purged };
        break;
      }
      case 'privacy':
        await this.get(PrivacyScheduler).run();
        break;
      case 'token-cleanup':
        result = { purged: await this.get(AuthService).purgeStaleTokens() };
        break;
      case 'queues':
        result = await this.get(QueueService).drain();
        break;
      case 'queue-prune':
        await this.get(QueueService).prune();
        break;
    }
    return { job, ok: true, durationMs: Date.now() - started, ...(result && typeof result === 'object' ? { result } : {}) };
  }
}
