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
   * T0.1 不检查数据库与存储目录；`/health/ready` 依赖的就绪检查在 T1.1 与 T6.3 中补充。
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
