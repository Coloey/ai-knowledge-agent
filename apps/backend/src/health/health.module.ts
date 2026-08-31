import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { DatabaseHealthIndicator } from './database.health';
import { HealthController, LegacyHealthController } from './health.controller';
import { RedisHealthIndicator } from './redis.health';
import { StorageModule } from '../storage/storage.module';
import { StorageHealthIndicator } from './storage.health';

@Module({
  imports: [TerminusModule, StorageModule],
  controllers: [HealthController, LegacyHealthController],
  providers: [DatabaseHealthIndicator, RedisHealthIndicator, StorageHealthIndicator],
})
export class HealthModule {}
