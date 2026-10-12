import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadConfig } from './config';

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config));
  app.enableCors({
    origin: config.corsOrigins,
    allowedHeaders: ['content-type', 'x-user-id'],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });
  app.enableShutdownHooks();
  await app.listen(config.port);
  console.log(JSON.stringify({ message: 'api listening', port: config.port, bucket: config.bucket }));
}

void bootstrap();
