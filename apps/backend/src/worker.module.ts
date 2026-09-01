import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { validateEnvironment } from './config/environment';
import { DatabaseModule } from './database/database.module';
import { LibraryWorkerModule } from './library/library-worker.module';
import { QueueInfrastructureModule } from './queue/queue.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env', 'apps/backend/.env'],
      validate: validateEnvironment,
    }),
    LoggerModule.forRoot({ pinoHttp: { level: process.env.LOG_LEVEL || 'info' } }),
    DatabaseModule,
    QueueInfrastructureModule,
    LibraryWorkerModule,
  ],
})
export class WorkerModule {}
