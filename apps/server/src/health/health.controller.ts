import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';

import {
  HealthService,
  type HealthStatus,
  type LivenessStatus,
  type ReadinessStatus,
} from './health.service';

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

  @Get('ready')
  async getReadiness(@Res({ passthrough: true }) response: Response): Promise<ReadinessStatus> {
    const readiness = await this.healthService.getReadiness();
    response.status(readiness.status === 'ok' ? 200 : 503);
    return readiness;
  }
}
