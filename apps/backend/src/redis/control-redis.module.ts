import { Global, Module } from '@nestjs/common';

import { ControlRedisService } from './control-redis.service';

@Global()
@Module({
  providers: [ControlRedisService],
  exports: [ControlRedisService],
})
export class ControlRedisModule {}
