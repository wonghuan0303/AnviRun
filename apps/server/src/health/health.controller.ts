import { Controller, Get } from '@nestjs/common';

import { HealthService, type HealthStatus, type LivenessStatus } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getHealth(): HealthStatus {
    return this.healthService.getStatus();
  }

  @Get('live')
  getLiveness(): LivenessStatus {
    return this.healthService.getLiveness();
  }
}
