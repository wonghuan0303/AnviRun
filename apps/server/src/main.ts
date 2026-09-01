import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { resolveServerListenOptions } from './config/server.config';
import { configureRequestBodyLimits } from './common/request-body';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureRequestBodyLimits(app);
  const configService = app.get(ConfigService);

  const { host, port } = resolveServerListenOptions({
    SERVER_HOST: configService.get<string>('SERVER_HOST'),
    SERVER_PORT: configService.get<string>('SERVER_PORT'),
  });

  app.enableShutdownHooks();
  await app.listen(port, host);

  new Logger('Bootstrap').log(`Server listening on http://${host}:${port}/health`);
}

void bootstrap();
