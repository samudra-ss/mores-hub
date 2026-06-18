import {
  Injectable,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { IdBank } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { ComplianceService } from '../compliance/compliance.service';
import { PAYMENT_PROVIDER } from '../payments/payments.module';
import { PaymentProvider } from '../payments/provider.interface';

const VA_TTL_MIN = 60 * 24; // 24h

@Injectable()
export class TopupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly compliance: ComplianceService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async createOrder(params: {
    userId: string;
    walletId: string;
    bank: IdBank;
    amount: bigint;
  }) {
    if (params.amount < 10_000n) {
      throw new BadRequestException('Minimum top-up is IDR 10,000');
    }
    await this.compliance.assertWithinLimits(params.userId, params.amount);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: params.userId },
    });
    const wallet = await this.prisma.wallet.findUniqueOrThrow({
      where: { id: params.walletId },
    });
    if (wallet.ownerId !== params.userId) {
      throw new BadRequestException('You can only top up wallets you own');
    }

    const expiresAt = new Date(Date.now() + VA_TTL_MIN * 60 * 1000);
    const order = await this.prisma.topupOrder.create({
      data: {
        userId: params.userId,
        walletId: params.walletId,
        amount: params.amount,
        bank: params.bank,
        vaNumber: 'pending',
        expiresAt,
      },
    });

    const va = await this.provider.createVirtualAccount({
      bank: params.bank,
      amount: params.amount,
      externalRef: order.id,
      customerName: user.name,
      expiresAt,
    });

    return this.prisma.topupOrder.update({
      where: { id: order.id },
      data: { vaNumber: va.vaNumber, providerRef: va.providerRef },
    });
  }

  /**
   * Webhook handler — in production this is the bank/aggregator calling us
   * after the user's bank transfer settles. In mock mode it's exposed as a
   * dev endpoint you can hit manually.
   */
  async settleByProviderRef(providerRef: string) {
    const order = await this.prisma.topupOrder.findFirst({
      where: { providerRef },
    });
    if (!order) throw new NotFoundException('Top-up order not found');
    if (order.status !== 'AWAITING_PAYMENT') return order; // idempotent

    const systemWallet = await this.ledger.getSystemCashInWallet();
    const txn = await this.ledger.post({
      type: 'TOPUP',
      amount: order.amount,
      debitWalletId: order.walletId,
      creditWalletId: systemWallet.id,
      description: `Top-up via ${order.bank} VA ${order.vaNumber}`,
      category: 'topup',
      externalRef: `topup:${order.id}`,
    });

    await this.compliance.checkLtkt({
      userId: order.userId,
      walletId: order.walletId,
      amount: order.amount,
      reason: 'topup',
    });

    return this.prisma.topupOrder.update({
      where: { id: order.id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        transactionId: txn.id,
      },
    });
  }
}
