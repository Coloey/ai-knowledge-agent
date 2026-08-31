import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import type { Environment } from '../config/environment';

@Injectable()
export class ControlRedisService implements OnApplicationShutdown {
  readonly client: Redis;

  constructor(@Inject(ConfigService) config: ConfigService<Environment, true>) {
    this.client = new Redis(config.get('CONTROL_REDIS_URL', { infer: true }), {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectionName: 'ai-agent-control',
    });
    this.client.on('error', () => undefined);
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  async consumeRateLimit(key: string, ttlSeconds: number): Promise<number> {
    return Number(
      await this.client.eval(
        "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return count",
        1,
        key,
        ttlSeconds,
      ),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.status !== 'end') await this.client.quit().catch(() => this.client.disconnect());
  }
}
