import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import { AppModule } from './app.module';
import { httpsEnforcement } from './common/http/https-policy';
import { applyUploadBodyLimit } from './common/http/upload-body-limit';
import { apiCorsOptions, securityMiddleware } from './common/http/security-headers';
import { StructuredLogger } from './common/observability/structured-logger';
import { restoreMode } from './common/utils/restore-mode';

function setupApp(app: INestApplication) {
  const configService = app.get(ConfigService);
  const apiPrefix = configService.get<string>('app.apiPrefix', '/api/v1');
  const appName = configService.get<string>('app.appName', 'Orion Backend API');
  const corsOrigins = configService.get<string[]>('app.corsOrigins', ['http://localhost:3000']);

  // Graceful shutdown hooks
  app.enableShutdownHooks();

  // S-09: behind a reverse proxy (production), trust exactly one hop so req.ip / rate limiting key on the real
  // client IP from X-Forwarded-For. In non-proxied environments trust is left off so a client cannot spoof it.
  const httpAdapter = app.getHttpAdapter();
  if (typeof (httpAdapter as any).getInstance === 'function') {
    const expressInstance = (httpAdapter as any).getInstance();
    if (expressInstance && typeof expressInstance.set === 'function') {
      expressInstance.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
    }
  }

  // Production: a request the proxy marked as plain http is redirected to https (or refused) before anything else runs
  app.use(httpsEnforcement());

  // Security headers: Helmet (HSTS in production only, no includeSubDomains/preload) and then the strict Content-Security-Policy,
  // Permissions-Policy and no-store for credentialed responses. One chain, shared with the tests (common/http/security-headers.ts).
  for (const mw of securityMiddleware()) app.use(mw);

  // Response Compression
  app.use(compression());

  // Route-scoped body limit for the two admin upload routes only (the global JSON limit stays at the default)
  applyUploadBodyLimit(app, apiPrefix);

  // CORS
  app.enableCors(apiCorsOptions(corsOrigins));

  // Global API Prefix
  app.setGlobalPrefix(apiPrefix.replace(/^\//, ''), {
    exclude: ['/'],
  });

  // Global Validation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Swagger Documentation Setup
  const swaggerConfig = new DocumentBuilder()
    .setTitle(appName)
    .setDescription(
      'Enterprise Backend API for Orion — AI-Powered Business Discovery & Lead Intelligence Platform.\n\n' +
        'Engineered for 10M+ Business Records, High-Throughput Search, and Asynchronous Processing Queues.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT Access Token',
        in: 'header',
      },
      'JWT-auth',
    )
    .addTag('Health', 'System and infrastructure health monitoring')
    .addTag('Auth', 'Authentication infrastructure and tokens')
    .build();

  // S-15: the interactive API explorer and its full schema map every route (including internal admin
  // endpoints). It is mounted only outside production; set SWAGGER_ENABLED=true to force it on in a
  // controlled environment. In production it is never served anonymously.
  const swaggerEnabled =
    process.env.SWAGGER_ENABLED === 'true' ||
    (process.env.NODE_ENV !== 'production' && process.env.SWAGGER_ENABLED !== 'false');
  if (swaggerEnabled) {
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        filter: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
    });
  }

  return { configService, apiPrefix, appName };
}

async function bootstrap() {
  const logger = new Logger('OrionBootstrap');
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true, // exact request bytes for payment-webhook signature verification
  });
  app.useLogger(new StructuredLogger()); // JSON lines in production (LOG_FORMAT), with request and trace ids

  const { configService, apiPrefix, appName } = setupApp(app);
  const port = configService.get<number>('app.port', 4000);

  // S-03 / S-15: bind to all interfaces only in production (where a reverse proxy fronts the service).
  // In every other environment bind to loopback so a dev instance is never reachable from the network.
  const bindHost = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
  await app.listen(port, bindHost);

  logger.log(`=======================================================`);
  logger.log(`🚀 ${appName} running in [${process.env.NODE_ENV || 'development'}] mode`);
  logger.log(`📡 Server URL: http://localhost:${port}`);
  logger.log(`📚 Swagger Docs: http://localhost:${port}/docs`);
  logger.log(`🩺 Health Check: http://localhost:${port}${apiPrefix}/health`);
  if (restoreMode()) logger.warn('RESTORE_MODE is ON: no queue worker, scheduled export, webhook delivery, credit rollover or retention job is running. Unset it and restart once the restore has been verified.');
  logger.log(`=======================================================`);
}

// Vercel Serverless entry point
let serverlessExpress: any;

async function bootstrapServerless() {
  if (!serverlessExpress) {
    const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
    app.useLogger(new StructuredLogger());
    setupApp(app);
    await app.init();
    serverlessExpress = app.getHttpAdapter().getInstance();
  }
  return serverlessExpress;
}

if (!process.env.VERCEL) {
  bootstrap();
}

export default async function handler(req: any, res: any) {
  const server = await bootstrapServerless();
  return server(req, res);
}
