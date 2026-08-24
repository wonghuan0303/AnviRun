import { Test, type TestingModule } from '@nestjs/testing';

import { HealthController } from './health.controller';
import { HealthModule } from './health.module';

describe('HealthController', () => {
  let moduleRef: TestingModule;
  let controller: HealthController;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({ imports: [HealthModule] }).compile();
    controller = moduleRef.get(HealthController);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('resolves the controller through the module', () => {
    expect(controller).toBeInstanceOf(HealthController);
  });

  it('answers the liveness probe', () => {
    expect(controller.getLiveness()).toEqual({ status: 'ok' });
  });

  it('reports service status including the shared contracts package', () => {
    const status = controller.getHealth();

    expect(status.status).toBe('ok');
    expect(status.service).toBe('@buildplatform/server');
    expect(status.contracts.name).toBe('@buildplatform/contracts');
    expect(status.contracts.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
