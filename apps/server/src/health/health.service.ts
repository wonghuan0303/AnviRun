import { Injectable } from '@nestjs/common';
import { getContractsPackageInfo } from '@buildplatform/contracts';

import { SERVICE_NAME } from '../config/server.config';

/** 最小健康检查响应。 */
export interface HealthStatus {
  status: 'ok';
  service: string;
  contracts: {
    name: string;
    version: string;
  };
  uptimeSeconds: number;
}

/** 存活探针响应。 */
export interface LivenessStatus {
  status: 'ok';
}

@Injectable()
export class HealthService {
  /**
   * 返回服务基础状态。
   *
   * T1.1 已建立 Prisma 数据层，但本任务不新增 `/health/ready`；完整数据库与存储就绪探针留给 T6.3。
   */
  getStatus(): HealthStatus {
    const contracts = getContractsPackageInfo();

    return {
      status: 'ok',
      service: SERVICE_NAME,
      contracts: {
        name: contracts.name,
        version: contracts.version,
      },
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  getLiveness(): LivenessStatus {
    return { status: 'ok' };
  }
}
