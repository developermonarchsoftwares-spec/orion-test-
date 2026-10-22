/**
 * RESTORE_MODE=true starts the API WITHOUT any background work: no queue workers, no scheduled exports, no webhook deliveries, no daily
 * credit allocation, no retention or token clean-up. Use it for the first start after restoring a database (docs/BACKUP_AND_DISASTER_RECOVERY.md
 * section 5): a restored database still holds the jobs, schedules and deliveries of the moment of the backup, and its wallets and
 * deletions are older than reality. Without the switch those jobs start by themselves a few seconds after boot, before the deletion
 * ledger has been re-applied (observed in Phase 30: the dispatcher, the credit rollover and the queue all touched the restored database
 * at once). Requests are still answered, so the restore can be checked through the API; then unset it and restart.
 */
export const restoreMode = (env: NodeJS.ProcessEnv = process.env): boolean => (env.RESTORE_MODE ?? '').trim().toLowerCase() === 'true';

/**
 * True on Vercel, where the API runs as a function: an in-process timer only fires while an instance happens to be alive, so it can be
 * late, skipped or run on several instances. There the jobs are run by authenticated Vercel Cron calls (modules/cron) instead.
 * FORCE_BACKGROUND_JOBS=true turns the timers back on (an always-on host that sets VERCEL for other reasons).
 */
export const serverlessRuntime = (env: NodeJS.ProcessEnv = process.env): boolean => !!env.VERCEL && env.FORCE_BACKGROUND_JOBS !== 'true';

/** True when a background job owned by `disableFlag` must not start: tests, its own DISABLE_ flag, restore mode, or a serverless runtime. */
export const backgroundJobDisabled = (disableFlag?: string, env: NodeJS.ProcessEnv = process.env): boolean =>
  env.NODE_ENV === 'test' || restoreMode(env) || serverlessRuntime(env) || (!!disableFlag && env[disableFlag] === 'true');
