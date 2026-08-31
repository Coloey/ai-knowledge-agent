import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';

import { ApiExceptionFilter } from './common/api-exception.filter';
import type { Environment } from './config/environment';
import { parseCorsOrigins } from './config/environment';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: false,
      trustProxy: true,
      bodyLimit: 1024 * 1024,
      genReqId: (request: { headers: IncomingHttpHeaders }) =>
        String(request.headers['x-request-id'] || request.headers['x-requestid'] || randomUUID()),
    }),
    { bufferLogs: true },
  );
  const config = app.get(ConfigService<Environment, true>);
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onSend', (request, reply, payload, done) => {
    reply.header('x-request-id', request.id);
    done(null, payload);
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.register(helmet);
  await app.register(multipart, {
    limits: {
      fileSize: config.getOrThrow<number>('MAX_UPLOAD_BYTES'),
      files: 1,
      fields: 4,
    },
  });
  app.enableCors({
    origin: parseCorsOrigins(config.get('CORS_ORIGINS', { infer: true })),
    credentials: true,
  });
  await app.listen(config.getOrThrow<number>('PORT'), '0.0.0.0');
}

void bootstrap();
