import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PaymentRequest } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { SystemWalletsService } from './system-wallets.service';
import {
  DISBURSEMENT_PROVIDER,
  DisbursementProvider,
} from './disbursement.provider';

/**
 * Payout lifecycle. Ledger movements (LedgerService.post: debit wallet
 * receives, credit wallet pays):
 *
 *   start   CORPORATE_MAIN   -> CLEARING_GATEWAY   (status DISBURSING)
 *   settle  CLEARING_GATEWAY -> EXPENSE:<category> (status PAID)
 *   fail    CLEARING_GATEWAY -> CORPORATE_MAIN     (reversal, status FAILED)
 *
 * settle() is idempotent — the provider retries webhooks, and the mock timer
 * and the webhook endpoint share this code path. Double-settlement is
 * impossible: the payout row flips out of PENDING exactly once.
 */
@Injectable()
export class DisbursementService {
  private readonly logger = new Logger(DisbursementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallets: SystemWalletsService,
    @Inject(DISBURSEMENT_PROVIDER) private readonly provider: DisbursementProvider,
  ) {}

  async start(request: PaymentRequest) {
    const idempotencyKey = `payout-${request.id}-${randomUUID().slice(0, 8)}`;
    const { gatewayRef } = await this.provider.createDisbursement({
      idempotencyKey,
      amount: request.amount,
      bankCode: request.bankCode,
      bankAccount: request.bankAccount,
      holder: request.bankHolder,
    });

    const [corporate, clearing] = await Promise.all([
      this.wallets.corporateMain(),
      this.wallets.clearingGateway(),
    ]);
    const txn = await this.ledger.post({
      type: request.kind === 'REIMBURSEMENT' ? 'REIMBURSEMENT' : 'VENDOR_PAYMENT',
      amount: request.amount,
      debitWalletId: clearing.id,
      creditWalletId: corporate.id,
      description: `${request.ref} disbursement`,
      category: request.category,
      externalRef: idempotencyKey,
    });

    await this.prisma.gatewayPayout.create({
      data: {
        gatewayRef,
        idempotencyKey,
        requestId: request.id,
        amount: request.amount,
        bankCode: request.bankCode,
        bankAccount: request.bankAccount,
      },
    });
    await this.prisma.paymentRequest.update({
      where: { id: request.id },
      data: { status: 'DISBURSING', transactionId: txn.id },
    });
    return gatewayRef;
  }

  /** Terminal leg — called by the gateway webhook (and the mock's timer). */
  async settle(gatewayRef: string, ok: boolean) {
    // Atomic PENDING -> terminal flip; a second webhook for the same ref
    // matches zero rows and returns without touching the ledger.
    const { count } = await this.prisma.gatewayPayout.updateMany({
      where: { gatewayRef, status: 'PENDING' },
      data: { status: ok ? 'SETTLED' : 'FAILED', settledAt: new Date() },
    });
    if (count === 0) return { handled: false }; // unknown or already settled

    const payout = await this.prisma.gatewayPayout.findUniqueOrThrow({
      where: { gatewayRef },
      include: { request: true },
    });
    const req = payout.request;
    const clearing = await this.wallets.clearingGateway();

    if (ok) {
      const expense = await this.wallets.expense(req.category);
      await this.ledger.post({
        type: req.kind === 'REIMBURSEMENT' ? 'REIMBURSEMENT' : 'VENDOR_PAYMENT',
        amount: payout.amount,
        debitWalletId: expense.id,
        creditWalletId: clearing.id,
        description: `${req.ref} settled (${gatewayRef})`,
        category: req.category,
      });
    } else {
      const corporate = await this.wallets.corporateMain();
      await this.ledger.post({
        type: 'REFUND',
        amount: payout.amount,
        debitWalletId: corporate.id,
        creditWalletId: clearing.id,
        description: `${req.ref} disbursement failed — reversal (${gatewayRef})`,
        category: req.category,
      });
    }

    await this.prisma.paymentRequest.update({
      where: { id: req.id },
      data: { status: ok ? 'PAID' : 'FAILED' },
    });
    this.logger.log(`payout ${gatewayRef} ${ok ? 'settled' : 'FAILED'} (${req.ref})`);
    return { handled: true };
  }

  async retry(requestId: string) {
    const req = await this.prisma.paymentRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new BadRequestException('Request not found');
    if (req.status !== 'FAILED') {
      throw new ConflictException('Only failed disbursements can be retried');
    }
    return this.start(req);
  }
}
