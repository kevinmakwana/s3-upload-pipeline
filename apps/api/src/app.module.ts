import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { createRemoteJWKSet } from 'jose';
import { createDocClient, createS3Client, DynamoFileStore } from '@s3up/data';
import { AuthGuard } from './auth/auth.guard';
import { HeaderAuthenticator, JwtAuthenticator } from './auth/authenticator';
import { AUTHENTICATOR, CONFIG, FILES, S3, S3_PRESIGNER } from './common/tokens';
import type { AppConfig } from './config';
import { FilesController } from './files/files.controller';
import { FilesService } from './files/files.service';
import { HealthController } from './health.controller';
import { UploadsController } from './uploads/uploads.controller';
import { UploadsService } from './uploads/uploads.service';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [UploadsController, FilesController, HealthController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: S3, useFactory: () => createS3Client() },
        {
          provide: S3_PRESIGNER,
          useFactory: () => createS3Client(config.s3PublicEndpoint ? { endpoint: config.s3PublicEndpoint } : {}),
        },
        { provide: FILES, useFactory: () => new DynamoFileStore(createDocClient(), config.table) },
        {
          provide: AUTHENTICATOR,
          useFactory: () =>
            config.auth.mode === 'jwt'
              ? new JwtAuthenticator(createRemoteJWKSet(new URL(config.auth.jwksUrl)), config.auth)
              : new HeaderAuthenticator(),
        },
        // Authenticate every route by default; opt out explicitly with @Public().
        { provide: APP_GUARD, useClass: AuthGuard },
        UploadsService,
        FilesService,
      ],
    };
  }
}
