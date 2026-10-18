import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import type { JsonLogger } from './common/logger';
import { LOGGER } from './common/tokens';
import { loadConfig } from './config';

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { bufferLogs: true });
  configureApp(app, config);
  await app.listen(config.port);
  app.get<JsonLogger>(LOGGER).event('info', 'api listening', { port: config.port, bucket: config.bucket, auth: config.auth.mode });
}

void bootstrap();
