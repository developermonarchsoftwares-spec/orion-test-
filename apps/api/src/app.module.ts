import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

// Config loaders & validation
import {
  appConfig,
  databaseConfig,
  typesenseConfig,
  jwtConfig,
  storageConfig,
  throttlerConfig,
  environmentValidationSchema,
} from './config';

// Core infrastructure modules
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './modules/queue/queue.module';
import { TypesenseModule } from './modules/typesense/typesense.module';
import { StorageModule } from './modules/storage/storage.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './modules/health/health.module';

import { CronController } from './modules/cron/cron.controller';

// Domain & Pipeline Modules
import { BusinessModule } from './modules/business/business.module';
import { ImportModule } from './modules/import/import.module';
import { SearchModule } from './modules/search/search.module';

// Customer Platform Modules (Sprint 4)
import { UserModule } from './modules/user/user.module';
import { DiscoverModule } from './modules/discover/discover.module';
import { SavedLeadsModule } from './modules/saved-leads/saved-leads.module';
import { SavedSearchesModule } from './modules/saved-searches/saved-searches.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { SettingsModule } from './modules/settings/settings.module';
import { PeopleModule } from './modules/people/people.module';

// Credit, Unlock & Payment Modules (Sprint 5)
import { CreditModule } from './modules/credit/credit.module';
import { UnlockModule } from './modules/unlock/unlock.module';
import { PaymentModule } from './modules/payment/payment.module';
import { ExportModule } from './modules/export/export.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { TrafficModule } from './modules/traffic/traffic.module';
import { PrivacyModule } from './modules/privacy/privacy.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { ObservabilityMiddleware } from './common/observability/observability.middleware';
import { TrafficMiddleware } from './modules/traffic/traffic.middleware';

// OAuth & Enterprise Identity (Sprint 16)
import { OAuthModule } from './modules/oauth/oauth.module';

// Guards, Filters, Interceptors, Middleware
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { InputGuardMiddleware } from './common/middleware/input-guard.middleware';
import { AuthenticationMiddleware } from './auth/auth.middleware';
import { AppController } from './app.controller';
import { Pool } from 'pg';
import { PG_POOL } from './database/database.constants';
import { DbThrottlerStorage } from './common/throttler/db-throttler.storage';

@Module({
  controllers: [AppController, CronController],
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        databaseConfig,
        typesenseConfig,
        jwtConfig,
        storageConfig,
        throttlerConfig,
      ],
      validationSchema: environmentValidationSchema,
      validationOptions: {
        abortEarly: false,
      },
    }),

    // Rate Limiting
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, PG_POOL],
      useFactory: (config: ConfigService, pool: Pool) => ({
        throttlers: [
          {
            ttl: config.get<number>('throttler.ttl', 60000),
            limit: config.get<number>('throttler.limit', 100),
          },
        ],
        // counters live in Postgres so every serverless instance shares them (falls back to memory if the table is unavailable)
        // (the e2e suites reset limits through the default in-memory storage, so they keep it)
        storage: process.env.NODE_ENV === 'test' ? undefined : new DbThrottlerStorage(pool),
      }),
    }),

    // Infrastructure Modules
    CommonModule,
    DatabaseModule,
    QueueModule,
    TypesenseModule,
    StorageModule,
    AuthModule,
    HealthModule,

    // Core Domain & Processing Modules
    BusinessModule,
    ImportModule,
    SearchModule,

    // Customer Platform Modules
    UserModule,
    DiscoverModule,
    SavedLeadsModule,
    SavedSearchesModule,
    DashboardModule,
    SettingsModule,
    PeopleModule,

    // Credit Engine & Unlock System
    CreditModule,
    UnlockModule,
    PaymentModule,
    ExportModule,
    IntegrationsModule,
    TrafficModule,
    PrivacyModule,
    MonitoringModule,

    // OAuth & Enterprise Identity
    OAuthModule,
  ],
  providers: [
    // Global Exception Handling
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    // Global Response Standardization
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
    // Global Rate Limiting Guard
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // Global JWT Authentication Guard (endpoints public by default with @Public())
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Global Role-Based Authorization Guard
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestIdMiddleware, InputGuardMiddleware, ObservabilityMiddleware, AuthenticationMiddleware, TrafficMiddleware)
      .forRoutes('*');
  }
}
