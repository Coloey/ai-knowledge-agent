import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { ControlRedisService } from '../redis/control-redis.service';

@Injectable()
export class SessionRateLimitGuard implements CanActivate {
  constructor(@Inject(ControlRedisService) private readonly redis: ControlRedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
    try {
      const count = await this.redis.consumeRateLimit(`rate:llm:${request.user.id}`, 60);
      if (count > 20) throw new HttpException('Too many AI requests', HttpStatus.TOO_MANY_REQUESTS);
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Rate limit service unavailable');
    }
  }
}
