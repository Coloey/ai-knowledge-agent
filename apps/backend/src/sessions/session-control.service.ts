import { Inject, Injectable } from '@nestjs/common';

import { ControlRedisService } from '../redis/control-redis.service';

@Injectable()
export class SessionControlService {
  private readonly localInterrupted = new Set<string>();

  constructor(@Inject(ControlRedisService) private readonly redis: ControlRedisService) {}

  async clear(sessionId: string): Promise<void> {
    this.localInterrupted.delete(sessionId);
    await this.redis.client.del(this.key(sessionId)).catch(() => undefined);
  }

  async interrupt(sessionId: string): Promise<void> {
    this.localInterrupted.add(sessionId);
    await this.redis.client.set(this.key(sessionId), '1', 'EX', 300).catch(() => undefined);
  }

  async isInterrupted(sessionId: string): Promise<boolean> {
    if (this.localInterrupted.has(sessionId)) return true;
    return (await this.redis.client.get(this.key(sessionId)).catch(() => null)) === '1';
  }

  private key(sessionId: string): string {
    return `sse:interrupt:${sessionId}`;
  }
}
