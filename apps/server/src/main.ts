import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { AuthConfigService } from './config/auth.config';
import { resolveServerListenOptions } from './config/server.config';
import { configureRequestBodyLimits } from './common/request-body';
import { configureWebStaticHosting } from './web/static-web';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureRequestBodyLimits(app);
  const configService = app.get(ConfigService);
  const authConfig = app.get(AuthConfigService).values;
  await configureWebStaticHosting(app, configService.get<string>('WEB_STATIC_ROOT'));

  const { host, port } = resolveServerListenOptions({
    SERVER_HOST: configService.get<string>('SERVER_HOST'),
    SERVER_PORT: configService.get<string>('SERVER_PORT'),
  });

  app.enableShutdownHooks();
  await app.listen(port, host);

  const logger = new Logger('Bootstrap');
  if (authConfig.insecureHttpMode) {
    logger.warn('可信内网 HTTP 模式已启用：Cookie 未使用 Secure；该模式不适合公网部署。');
  }
  logger.log(`Server listening on http://${host}:${port}/health`);
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Server startup failed';
  new Logger('Bootstrap').error(message);
  process.exitCode = 1;
});
