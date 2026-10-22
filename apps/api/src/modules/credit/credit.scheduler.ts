import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { CreditRepository } from './credit.repository';
import { CreditService } from './credit.service';
import { restoreMode, serverlessRuntime } from '../../common/utils/restore-mode';

@Injectable()
export class CreditScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CreditScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly creditRepo: CreditRepository,
    private readonly creditService: CreditService,
  ) {}

  onModuleInit() {
    if (restoreMode()) {
      this.logger.warn('RESTORE_MODE: the daily credit rollover is not running');
      return;
    }
    if (serverlessRuntime()) return; // Vercel: the daily rollover is run by the cron route
    this.logger.log('CreditScheduler initialized. Starting daily credit rollover worker...');
    this.stopped = false;
    // Initial check after 10 seconds
    this.initialTimer = setTimeout(() => void this.runDailyRollover(), 10000);

    // Check hourly for midnight date rollover across timezones
    this.timer = setInterval(() => void this.runDailyRollover(), 60 * 60 * 1000);
  }

  /** Stops both timers, stops a running rollover between wallets and waits for the wallet in progress, so nothing touches the database after shutdown. */
  async onModuleDestroy() {
    this.stopped = true;
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight?.catch(() => undefined);
  }

  runDailyRollover(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.inFlight = this.rollover().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async rollover(): Promise<void> {
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const walletsToReset = await this.creditRepo.findWalletsNeedingDailyReset(todayStr, 200);

      if (walletsToReset.length > 0) {
        this.logger.log(`Found ${walletsToReset.length} wallets needing daily credit rollover for ${todayStr}`);
        for (const wallet of walletsToReset) {
          if (this.stopped) return;
          try {
            await this.creditService.syncDailyCredits(wallet.userId);
          } catch (err: any) {
            this.logger.error(`Failed to rollover daily credits for wallet ${wallet.id}: ${err.message}`);
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Error in runDailyRollover: ${error.message}`);
    }
  }
}
