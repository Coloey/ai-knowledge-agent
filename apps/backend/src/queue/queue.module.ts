import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

import type { Environment } from '../config/environment';
import { redisOptionsFromUrl } from './queue-connection';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) => ({
        connection: redisOptionsFromUrl(config.get('QUEUE_REDIS_URL', { infer: true })),
        prefix: 'ai-agent',
        defaultJobOptions: {
          attempts: 4,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueInfrastructureModule {}
