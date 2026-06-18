import {
  Injectable,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { CardBrand } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import { LedgerService } from '../ledger/ledger.service';
import { PAYMENT_PROVIDER } from '../payments/payments.module';
import { PaymentProvider } from '../payments/provider.interface';

@Injectable()
export class CardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletsService,
    private readonly ledger: LedgerService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async issue(params: {
    userId: string;
    walletId: string;
    brand: CardBrand;
  }) {
    await this.wallets.getOrThrow(params.walletId, params.userId);

    const issued = await this.provider.issueVirtualCard({
      userId: params.userId,
      brand: params.brand === 'GPN' ? 'VISA' : params.brand,
    });

    return this.prisma.card.create({
      data: {
        userId: params.userId,
        walletId: params.walletId,
        brand: params.brand,
        last4: issued.last4,
        panToken: issued.panToken,
        expMonth: issued.expMonth,
        expYear: issued.expYear,
      },
    });
  }

  /**
   * Authorize a card transaction. Holds funds (creates a PENDING transaction)
   * until capture. Real card networks distinguish auth/capture/clearing —
   * we model the same flow so swapping in a real issuer is one-line.
   */
  async authorize(params: { cardId: string; amount: bigint; merchant: string }) {
    const card = await this.prisma.card.findUnique({ where: { id: params.cardId } });
    if (!card || card.status !== 'ACTIVE') {
      throw new NotFoundException('Card not active');
    }
    return this.ledger.post({
      type: 'CARD_AUTH',
      amount: params.amount,
      debitWalletId: (await this.ledger.getSystemCashInWallet()).id, // funds out of user → settlement holding
      creditWalletId: card.walletId,
      description: `Card auth at ${params.merchant}`,
      category: 'card',
    });
  }

  async list(userId: string) {
    return this.prisma.card.findMany({
      where: { userId },
      select: {
        id: true,
        brand: true,
        last4: true,
        expMonth: true,
        expYear: true,
        status: true,
        spendingLimit: true,
        walletId: true,
        createdAt: true,
      },
    });
  }
}
