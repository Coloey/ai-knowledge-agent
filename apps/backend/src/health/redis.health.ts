import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';

import { ControlRedisService } from '../redis/control-redis.service';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    @Inject(ControlRedisService) private readonly redis: ControlRedisService,
    @Inject(HealthIndicatorService) private readonly healthIndicator: HealthIndicatorService,
  ) {}

  async isHealthy() {
    const indicator = this.healthIndicator.check('redis');
    try {
      const response = await this.redis.ping();
      return response === 'PONG' ? indicator.up() : indicator.down({ response });
    } catch (error) {
      return indicator.down({ message: error instanceof Error ? error.message : 'Redis unavailable' });
    }
  }
}
