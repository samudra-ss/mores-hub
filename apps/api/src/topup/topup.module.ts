import { Module } from '@nestjs/common';
import { TopupController } from './topup.controller';
import { TopupService } from './topup.service';
import { LedgerModule } from '../ledger/ledger.module';
import { ComplianceModule } from '../compliance/compliance.module';

@Module({
  imports: [LedgerModule, ComplianceModule],
  controllers: [TopupController],
  providers: [TopupService],
})
export class TopupModule {}
