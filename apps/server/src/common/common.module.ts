import { Global, Module } from '@nestjs/common';

import { AuditService } from './audit.service';
import { ApiExceptionFilter } from './filters/api-exception.filter';

@Global()
@Module({
  providers: [AuditService, ApiExceptionFilter],
  exports: [AuditService, ApiExceptionFilter],
})
export class CommonModule {}
