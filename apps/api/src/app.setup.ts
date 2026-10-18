import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { AppConfig } from './config';

/**
 * Everything main.ts configures on the Nest app, in one place so tests run the same setup.
 * Hardening headers come first so they are on every response, including CORS preflights and errors.
 */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  // Behind a load balancer the socket peer is the balancer; trust exactly its hops so req.ip (and
  // therefore the per-address rate limit) is the real client. 0 trusts nothing, so a client cannot
  // choose its own address with X-Forwarded-For.
  app.set('trust proxy', config.trustProxyHops);
  app.use(helmet());
  app.enableCors({
    origin: config.corsOrigins,
    allowedHeaders: ['content-type', 'x-user-id', 'authorization'],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });
  app.enableShutdownHooks();
}
