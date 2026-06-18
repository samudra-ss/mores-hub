import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';

interface PeriodSpec {
  from: Date;
  to: Date;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletsService,
  ) {}

  /**
   * Expense report (#9 from product spec): money out of a wallet, grouped by
   * category and counterparty user, over a period.
   */
  async walletExpenses(
    walletId: string,
    userId: string,
    period: PeriodSpec,
  ) {
    await this.wallets.getOrThrow(walletId, userId);

    const credits = await this.prisma.ledgerEntry.findMany({
      where: {
        walletId,
        direction: 'CREDIT',
        createdAt: { gte: period.from, lte: period.to },
        transaction: { status: 'COMPLETED' },
      },
      include: { transaction: true },
    });

    const total = credits.reduce((acc, e) => acc + e.amount, 0n);
    const byCategory = new Map<string, bigint>();
    for (const e of credits) {
      const cat = e.transaction.category ?? 'uncategorized';
      byCategory.set(cat, (byCategory.get(cat) ?? 0n) + e.amount);
    }
    return {
      walletId,
      from: period.from,
      to: period.to,
      total: total.toString(),
      count: credits.length,
      byCategory: Array.from(byCategory.entries()).map(([category, amount]) => ({
        category,
        amount: amount.toString(),
      })),
    };
  }

  /**
   * Per-person usage on a shared wallet: who in the access list is spending
   * the most. Useful for shared family / team wallets.
   */
  async sharedWalletByPerson(walletId: string, userId: string, period: PeriodSpec) {
    await this.wallets.getOrThrow(walletId, userId);

    // Money OUT of this wallet, attributed by the user listed as `actor` —
    // for now we infer actor from the wallet owner of the offsetting DEBIT
    // entry. In production you'd record actorUserId on Transaction directly.
    const credits = await this.prisma.ledgerEntry.findMany({
      where: {
        walletId,
        direction: 'CREDIT',
        createdAt: { gte: period.from, lte: period.to },
        transaction: { status: 'COMPLETED' },
      },
      include: {
        transaction: {
          include: { entries: { include: { wallet: { include: { owner: true } } } } },
        },
      },
    });

    const byPerson = new Map<string, { name: string; total: bigint; count: number }>();
    for (const e of credits) {
      // The "spender" is whoever owns the receiving wallet's spending side —
      // for QRIS payments, the merchant; for transfers, the recipient. As a
      // placeholder we attribute to the wallet owner of the DEBIT side.
      const debit = e.transaction.entries.find((x) => x.direction === 'DEBIT');
      if (!debit) continue;
      const owner = debit.wallet.owner;
      const cur = byPerson.get(owner.id) ?? { name: owner.name, total: 0n, count: 0 };
      cur.total += e.amount;
      cur.count += 1;
      byPerson.set(owner.id, cur);
    }

    return Array.from(byPerson.entries()).map(([userId, v]) => ({
      userId,
      name: v.name,
      total: v.total.toString(),
      count: v.count,
    }));
  }
}
