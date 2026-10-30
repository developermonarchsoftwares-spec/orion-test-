import { heapLimitBytes } from './heap-limit';
import { Controller, Get, HttpStatus, Param, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthCheck, HealthCheckService, MemoryHealthIndicator } from '@nestjs/terminus';
import { UserRole } from '@orion/shared';
import type { Request, Response } from 'express';
import { Public } from '../../auth/decorators';
import { DependencyName, HealthService } from './health.service';
import { DatabaseHealthIndicator } from './indicators/database.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StorageHealthIndicator } from './indicators/storage.health';
import { TypesenseHealthIndicator } from './indicators/typesense.health';

/**
 * Health endpoints. All are public (a load balancer or orchestrator calls them without credentials) and answer `Cache-Control: no-store`.
 * A public caller sees status and latency only; an administrator (Bearer token) also gets details such as versions and pool figures.
 * Failure reasons are fixed codes, never raw error text.
 *
 *   /health/live      the process is running and its event loop turns            (restart me if this fails)
 *   /health/ready     this instance should receive traffic                       (stop sending traffic if this fails)
 *   /health/database  /health/typesense  /health/redis  /health/storage    one dependency each
 *   /health           the comprehensive report (every dependency and memory)
 */
const DEPENDENCIES: Record<string, DependencyName> = { database: 'database', typesense: 'typesense', redis: 'redis', storage: 'storage' };

const isAdmin = (req: Request) => {
  const role = (req as any).user?.role;
  return role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
};

// Not subject to the global per-address throttler either: a probe answered with 429 would make a load balancer take a healthy instance out of rotation.
@SkipThrottle()
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly terminus: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly dbIndicator: DatabaseHealthIndicator,
    private readonly typesenseIndicator: TypesenseHealthIndicator,
    private readonly redisIndicator: RedisHealthIndicator,
    private readonly storageIndicator: StorageHealthIndicator,
    private readonly health: HealthService,
  ) {}

  @Public()
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Application health: every dependency (database, search, Redis, storage) and memory, in one report' })
  @ApiResponse({ status: 200, description: 'All critical backend services are operational' })
  @ApiResponse({ status: 503, description: 'One or more critical services are degraded/unreachable' })
  async check() {
    return this.terminus.check([
      () => this.dbIndicator.isHealthy('database'),
      () => this.typesenseIndicator.isHealthy('typesense'),
      () => this.redisIndicator.isHealthy('redis'),
      () => this.storageIndicator.isHealthy('storage'),
      () => this.memory.checkHeap('memory_heap', heapLimitBytes()), // 1 GiB unless HEALTH_HEAP_LIMIT_MB says otherwise
    ]);
  }

  @Public()
  @Get(['live', 'liveness'])
  @ApiOperation({ summary: 'Liveness probe: the process is running and responsive. Never depends on a dependency, so an outage elsewhere does not restart the service.' })
  @ApiResponse({ status: 200, description: 'Alive' })
  @ApiResponse({ status: 503, description: 'The event loop is blocked: restart the process' })
  async live(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const { ok, body } = await this.health.liveness();
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }

  @Public()
  @Get(['ready', 'readiness'])
  @ApiOperation({ summary: 'Readiness probe: should this instance receive traffic? Required dependencies are up and the instance is not shutting down.' })
  @ApiResponse({ status: 200, description: 'Ready (status ok, or degraded when only an optional dependency is down)' })
  @ApiResponse({ status: 503, description: 'Not ready: a required dependency is down, or the instance is shutting down' })
  async ready(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const { ready, body } = await this.health.readiness(isAdmin(req));
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }

  @Public()
  @Get(':dependency')
  @ApiOperation({ summary: 'One dependency: database, typesense, redis or storage' })
  @ApiResponse({ status: 200, description: 'Up, or skipped because it is not configured / not in use' })
  @ApiResponse({ status: 503, description: 'Down' })
  @ApiResponse({ status: 404, description: 'Unknown dependency' })
  async dependency(@Param('dependency') dependency: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const name = DEPENDENCIES[dependency];
    if (!name) {
      res.status(HttpStatus.NOT_FOUND);
      return { status: 'unknown', message: `Unknown dependency. Use one of: ${Object.keys(DEPENDENCIES).join(', ')}` };
    }
    const r = await this.health.check(name, isAdmin(req));
    res.status(r.status === 'down' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK);
    return { ...r, required: this.health.requirements()[name], timestamp: new Date().toISOString() };
  }
}
