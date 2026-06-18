import { Module } from '@nestjs/common';
import { ComplianceService } from './compliance.service';
import { SanctionsService } from './sanctions.service';

@Module({
  providers: [ComplianceService, SanctionsService],
  exports: [ComplianceService, SanctionsService],
})
export class ComplianceModule {}
