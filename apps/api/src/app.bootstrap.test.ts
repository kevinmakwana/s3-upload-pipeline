import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';

/**
 * Starts the API the way production and the integration tests do (`NestFactory.create`, which loads the HTTP
 * adapter itself) rather than through Nest's testing module, which the other suites use. NestJS 12 is ESM only,
 * so this guards the Jest setup that lets it load (tests/support/esm-to-cjs.cjs). Nothing here reaches AWS.
 */
describe('API start-up', () => {
  it('boots the real module graph and answers /health', async () => {
    const config = loadConfig({
      BUCKET_NAME: 'bucket',
      TABLE_NAME: 'table',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      AWS_ENDPOINT_URL: 'http://127.0.0.1:9',
      PORT: '0',
    });
    const app = await NestFactory.create(AppModule.register(config), { logger: false });
    try {
      await app.listen(0, '127.0.0.1');
      const { port } = app.getHttpServer().address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
