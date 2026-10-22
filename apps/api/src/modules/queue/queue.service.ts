import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Inject } from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { DRIZZLE_DATABASE, PG_POOL } from '../../database/database.constants';
import { DrizzleDb } from '../../database/database.provider';
import { queueJobs, QueueJob } from '../../database/schema/queue_jobs';
import { QUEUE_NAMES, QueueNameType } from './queue.constants';
import { captureException } from '../../common/observability/error-tracker';
import { restoreMode, serverlessRuntime } from '../../common/utils/restore-mode';

export interface IQueueStats {
  queueName: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
}

export interface IJobPayload<T = unknown> {
  id: string;
  name: string;
  data: T;
}

export type JobHandler<T = unknown, R = unknown> = (job: IJobPayload<T>) => Promise<R>;

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly handlers = new Map<string, JobHandler<any, any>>();
  private readonly activeWorkers = new Set<string>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: DrizzleDb,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  onModuleInit() {
    this.logger.log('Initializing PostgreSQL Queue Engine...');
    if (restoreMode()) this.logger.warn('RESTORE_MODE: queue workers are not started; waiting jobs stay waiting');

    // Vercel: the cron route prunes and drains the queues instead of a timer
    if (serverlessRuntime()) return;

    // Periodically clean up old completed/failed jobs (> 7 days) every 6 hours
    this.cleanupInterval = setInterval(
      () => {
        this.pruneOldJobs().catch((err) => {
          this.logger.warn(`Failed to prune old queue jobs: ${err.message}`);
        });
      },
      6 * 60 * 60 * 1000,
    );
  }

  /**
   * Register a worker callback for a given queue
   */
  registerWorker<T = unknown, R = unknown>(queueName: string, handler: JobHandler<T, R>) {
    if (restoreMode()) return; // jobs restored with the database must not run before the deletion ledger has been re-applied
    this.handlers.set(queueName, handler);
    this.logger.log(`Registered PostgreSQL queue worker for: ${queueName}`);

    // Process any pending jobs waiting in this queue
    setImmediate(() => this.processPendingJobs(queueName));
  }

  /** Processes the waiting jobs of every registered queue once and waits for them (called by the cron route on Vercel). */
  async drain(): Promise<{ queues: number }> {
    if (restoreMode()) return { queues: 0 };
    const names = [...this.handlers.keys()];
    await Promise.all(names.map((n) => this.processPendingJobs(n)));
    return { queues: names.length };
  }

  /** Removes finished jobs older than 7 days. */
  prune(): Promise<unknown> {
    return this.pruneOldJobs();
  }

  /**
   * Unregister a worker
   */
  unregisterWorker(queueName: string) {
    this.handlers.delete(queueName);
    this.logger.log(`Unregistered queue worker for: ${queueName}`);
  }

  /**
   * Add a job to the PostgreSQL queue
   */
  async addJob<T = unknown>(
    queueName: QueueNameType | string,
    jobName: string,
    data: T,
    options?: { attempts?: number },
  ): Promise<{ id: string; name: string; data: T }> {
    const maxAttempts = options?.attempts || 3;

    const [inserted] = await this.db
      .insert(queueJobs)
      .values({
        queueName,
        jobName,
        data: data as any,
        status: 'WAITING',
        attempts: 0,
        maxAttempts,
      })
      .returning();

    this.logger.debug(`Enqueued job ${inserted.id} [${jobName}] in queue ${queueName}`);

    // Trigger async processing immediately
    setImmediate(() => this.processPendingJobs(queueName));

    return {
      id: inserted.id,
      name: jobName,
      data,
    };
  }

  /**
   * Process waiting jobs for a specific queue
   */
  private async processPendingJobs(queueName: string) {
    const handler = this.handlers.get(queueName);
    if (!handler) return;

    if (this.activeWorkers.has(queueName)) {
      return; // Already actively looping
    }

    this.activeWorkers.add(queueName);

    try {
      while (this.handlers.has(queueName)) {
        // Atomically claim the next waiting job using SELECT FOR UPDATE SKIP LOCKED
        const client = await this.pool.connect();
        let claimedJob: QueueJob | null = null;

        try {
          await client.query('BEGIN');
          const res = await client.query(
            `SELECT * FROM queue_jobs 
             WHERE queue_name = $1 AND status = 'WAITING' 
             ORDER BY created_at ASC 
             FOR UPDATE SKIP LOCKED 
             LIMIT 1`,
            [queueName],
          );

          if (res.rows.length > 0) {
            const row = res.rows[0];
            await client.query(
              `UPDATE queue_jobs 
               SET status = 'ACTIVE', locked_at = NOW(), updated_at = NOW() 
               WHERE id = $1`,
              [row.id],
            );
            await client.query('COMMIT');
            claimedJob = row;
          } else {
            await client.query('COMMIT');
          }
        } catch (txErr) {
          await client.query('ROLLBACK').catch(() => {});
          throw txErr;
        } finally {
          client.release();
        }

        if (!claimedJob) {
          // No more waiting jobs
          break;
        }

        // Execute the handler
        const currentJob = claimedJob;
        const jobName = (currentJob as any).job_name || currentJob.jobName;
        this.logger.debug(`Processing job ${currentJob.id} [${jobName}]`);

        try {
          const result = await handler({
            id: currentJob.id,
            name: jobName,
            data: currentJob.data,
          });

          await this.db
            .update(queueJobs)
            .set({
              status: 'COMPLETED',
              result: (result as any) || null,
              processedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(queueJobs.id, currentJob.id));

          this.logger.debug(`Job ${currentJob.id} completed successfully`);
        } catch (err: any) {
          const attempts = (currentJob.attempts || 0) + 1;
          const maxAttempts = (currentJob as any).max_attempts || currentJob.maxAttempts || 3;
          const isFailed = attempts >= maxAttempts;

          this.logger.error(
            `Job ${currentJob.id} failed (attempt ${attempts}/${maxAttempts}): ${err.message}`,
            err.stack,
          );

          // only the final failure is reported: a retry that then succeeds is not an incident
          if (isFailed) captureException(err, { source: 'queue', tags: { queue: queueName, job: String(jobName), attempts: String(attempts) } });

          await this.db
            .update(queueJobs)
            .set({
              status: isFailed ? 'FAILED' : 'WAITING',
              attempts,
              error: err.message || 'Unknown error',
              updatedAt: new Date(),
            })
            .where(eq(queueJobs.id, currentJob.id));
        }
      }
    } catch (err: any) {
      this.logger.error(`Error processing queue ${queueName}: ${err.message}`, err.stack);
    } finally {
      this.activeWorkers.delete(queueName);
    }
  }

  /**
   * Return stats for a specific queue
   */
  async getQueueStats(queueName: QueueNameType | string): Promise<IQueueStats> {
    try {
      const statsRes = await this.pool.query(
        `SELECT 
           COUNT(*) FILTER (WHERE status = 'WAITING')::int AS waiting,
           COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
           COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
           COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
         FROM queue_jobs 
         WHERE queue_name = $1`,
        [queueName],
      );

      const row = statsRes.rows[0] || {};

      return {
        queueName,
        waiting: row.waiting || 0,
        active: row.active || 0,
        completed: row.completed || 0,
        failed: row.failed || 0,
        delayed: 0,
        paused: false,
      };
    } catch (err: any) {
      this.logger.error(`Failed to get queue stats for ${queueName}: ${err.message}`);
      return {
        queueName,
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: false,
      };
    }
  }

  /**
   * Return stats for all known queues
   */
  async getAllQueueStats(): Promise<IQueueStats[]> {
    const stats: IQueueStats[] = [];
    for (const queueName of Object.values(QUEUE_NAMES)) {
      stats.push(await this.getQueueStats(queueName));
    }
    return stats;
  }

  /**
   * Health ping for the queue engine
   */
  async ping(): Promise<boolean> {
    try {
      const res = await this.pool.query('SELECT 1');
      return Boolean(res.rowCount && res.rowCount > 0);
    } catch (error) {
      this.logger.error('Queue health ping failed', error);
      return false;
    }
  }

  /**
   * Cleanup old completed and failed jobs
   */
  async pruneOldJobs(daysToKeep = 7) {
    try {
      await this.pool.query(
        `DELETE FROM queue_jobs 
         WHERE status IN ('COMPLETED', 'FAILED') 
         AND created_at < NOW() - INTERVAL '${daysToKeep} days'`,
      );
    } catch (err: any) {
      this.logger.warn(`Pruning queue jobs failed: ${err.message}`);
    }
  }

  async onModuleDestroy() {
    this.logger.log('Closing PostgreSQL Queue Engine...');
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.handlers.clear();
    this.activeWorkers.clear();
  }
}
