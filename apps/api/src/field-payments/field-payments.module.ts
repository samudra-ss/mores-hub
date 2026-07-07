import { Module, OnModuleInit } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { FieldPaymentsController } from './field-payments.controller';
import { FieldPaymentsService } from './field-payments.service';
import { DisbursementService } from './disbursement.service';
import { ReconciliationService } from './reconciliation.service';
import { StorageService } from './storage.service';
import { SystemWalletsService } from './system-wallets.service';
import {
  DISBURSEMENT_PROVIDER,
  MockDisbursementProvider,
} from './disbursement.provider';

/**
 * Field payments — reimbursements, vendor payment orders, budget allocation,
 * gateway disbursement and nightly ledger reconciliation.
 *
 * Ported from the apps/payments Flask prototype (the executable spec).
 * Swap MockDisbursementProvider for XenditProvider to go live — nothing else
 * changes (docs/FRAMEWORK-REVIEW.md §2.4).
 */
@Module({
  imports: [LedgerModule],
  controllers: [FieldPaymentsController],
  providers: [
    FieldPaymentsService,
    DisbursementService,
    ReconciliationService,
    StorageService,
    SystemWalletsService,
    MockDisbursementProvider,
    { provide: DISBURSEMENT_PROVIDER, useExisting: MockDisbursementProvider },
  ],
  exports: [FieldPaymentsService],
})
export class FieldPaymentsModule implements OnModuleInit {
  constructor(
    private readonly mock: MockDisbursementProvider,
    private readonly disbursement: DisbursementService,
  ) {}

  /** Wire the mock's settle timer to the same idempotent path the webhook uses. */
  onModuleInit() {
    this.mock.onSettle = (gatewayRef, ok) => this.disbursement.settle(gatewayRef, ok);
  }
}
