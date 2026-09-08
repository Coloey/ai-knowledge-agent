import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { AuthModule } from './auth/auth.module';
import { ArtifactApiModule } from './artifacts/artifact-api.module';
import { validateEnvironment } from './config/environment';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { LibraryApiModule } from './library/library-api.module';
import { QueueInfrastructureModule } from './queue/queue.module';
import { ControlRedisModule } from './redis/control-redis.module';
import { SessionsModule } from './sessions/sessions.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env', 'apps/backend/.env'],
      validate: validateEnvironment,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL || 'info',
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers.set-cookie',
            '*.password',
            '*.refresh_token',
          ],
          censor: '[REDACTED]',
        },
        autoLogging: { ignore: (request) => request.url === '/health/live' },
      },
    }),
    DatabaseModule,
    QueueInfrastructureModule,
    ControlRedisModule,
    AuthModule,
    ArtifactApiModule,
    WorkspacesModule,
    LibraryApiModule,
    SessionsModule,
    HealthModule,
  ],
})
export class AppModule {}
