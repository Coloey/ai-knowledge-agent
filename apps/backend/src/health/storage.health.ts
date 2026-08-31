import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';

import { ObjectStorageService } from '../storage/object-storage.service';

@Injectable()
export class StorageHealthIndicator {
  constructor(
    @Inject(ObjectStorageService) private readonly storage: ObjectStorageService,
    @Inject(HealthIndicatorService) private readonly healthIndicator: HealthIndicatorService,
  ) {}

  async isHealthy() {
    const indicator = this.healthIndicator.check('storage');
    try {
      await this.storage.healthCheck();
      return indicator.up();
    } catch (error) {
      return indicator.down({ message: error instanceof Error ? error.message : 'Storage unavailable' });
    }
  }
}
