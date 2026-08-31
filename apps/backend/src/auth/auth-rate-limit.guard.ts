import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { ControlRedisService } from '../redis/control-redis.service';

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(@Inject(ControlRedisService) private readonly redis: ControlRedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    try {
      const count = await this.redis.consumeRateLimit(`rate:auth:${request.ip}`, 300);
      if (count > 20) throw new HttpException('Too many authentication attempts', HttpStatus.TOO_MANY_REQUESTS);
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // Authentication remains available during a control Redis incident.
      return true;
    }
  }
}
