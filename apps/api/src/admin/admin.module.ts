import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuditService } from './audit.service';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  controllers: [AdminController],
  providers: [AdminService, AuditService],
  exports: [AuditService],
})
export class AdminModule {}
