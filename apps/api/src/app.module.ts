import { Module, type DynamicModule, type ExecutionContext } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import { createRemoteJWKSet } from 'jose';
import { createDocClient, createS3Client, DynamoFileStore } from '@s3up/data';
import { AuthGuard } from './auth/auth.guard';
import { HeaderAuthenticator, JwtAuthenticator } from './auth/authenticator';
import { LoggingExceptionFilter } from './common/logging.filter';
import { JsonLogger } from './common/logger';
import { RetryAfterThrottlerGuard, callerKey } from './common/throttle';
import { AUTHENTICATOR, CHANGE_FEED, CONFIG, FILES, LOGGER, S3, S3_PRESIGNER } from './common/tokens';
import type { AppConfig } from './config';
import { PollingChangeFeed } from './files/change-feed';
import { FilesController } from './files/files.controller';
import { FilesService } from './files/files.service';
import { SnsSqsChangeFeed } from './files/sns-sqs-change-feed';
import { HealthController } from './health.controller';
import { UploadsController } from './uploads/uploads.controller';
import { UploadsService } from './uploads/uploads.service';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    const { rateLimits } = config;
    const minute = 60_000;
    // Anything but starting an upload is skipped by the 'init' throttler.
    const notInit = (ctx: ExecutionContext) => ctx.getClass() !== UploadsController || ctx.getHandler() !== UploadsController.prototype.init;
    return {
      module: AppModule,
      imports: [
        ThrottlerModule.forRoot({
          errorMessage: 'Too many requests. Slow down and try again shortly.',
          // Load-balancer health checks and monitors must never be refused.
          skipIf: (ctx) => ctx.getClass() === HealthController,
          throttlers: [
            { name: 'ip', ttl: minute, limit: rateLimits.ipPerMinute },
            { name: 'caller', ttl: minute, limit: rateLimits.callerPerMinute, getTracker: callerKey },
            { name: 'init', ttl: minute, limit: rateLimits.initPerMinute, getTracker: callerKey, skipIf: notInit },
          ],
        }),
      ],
      controllers: [UploadsController, FilesController, HealthController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: LOGGER, useFactory: () => new JsonLogger(config.logLevel) },
        { provide: APP_FILTER, useClass: LoggingExceptionFilter },
        { provide: S3, useFactory: () => createS3Client() },
        {
          provide: S3_PRESIGNER,
          useFactory: () => createS3Client(config.s3PublicEndpoint ? { endpoint: config.s3PublicEndpoint } : {}),
        },
        { provide: FILES, useFactory: () => new DynamoFileStore(createDocClient(), config.table) },
        {
          provide: CHANGE_FEED,
          inject: [LOGGER],
          useFactory: (logger: JsonLogger) => {
            if (!config.changes) return new PollingChangeFeed(config.ssePollMs);
            const region = process.env.AWS_REGION ?? 'us-east-1';
            return new SnsSqsChangeFeed(new SQSClient({ region }), new SNSClient({ region }), {
              ...config.changes,
              fallbackPollMs: config.ssePollMs,
              log: (level, message, fields) => logger.event(level, message, fields),
            });
          },
        },
        {
          provide: AUTHENTICATOR,
          useFactory: () =>
            config.auth.mode === 'jwt' ? new JwtAuthenticator(createRemoteJWKSet(new URL(config.auth.jwksUrl)), config.auth) : new HeaderAuthenticator(),
        },
        // Guards run in this order: rate limits first, so a flood of bad credentials is turned away
        // before any token is verified; then authenticate every route (opt out with @Public()).
        { provide: APP_GUARD, useClass: RetryAfterThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        UploadsService,
        FilesService,
      ],
    };
  }
}
