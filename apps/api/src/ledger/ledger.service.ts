import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma, TxnType, EntryDirection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The double-entry ledger.
 *
 *   Every monetary movement is one Transaction with N >= 2 LedgerEntry rows
 *   such that sum(DEBIT) === sum(CREDIT).  Balances are NEVER stored — they
 *   are summed from entries on read.
 *
 *   All writes happen inside a single Prisma transaction so partial failure
 *   is impossible.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a personal wallet for a freshly-signed-up user. */
  async bootstrapWallet(userId: string, name: string) {
    return this.prisma.wallet.create({
      data: {
        ownerId: userId,
        name,
        type: 'PERSONAL',
        access: {
          create: { userId, role: 'OWNER' },
        },
      },
    });
  }

  /** Sum of debits minus sum of credits for a single wallet. */
  async getBalance(walletId: string): Promise<bigint> {
    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['direction'],
      where: { walletId, transaction: { status: 'COMPLETED' } },
      _sum: { amount: true },
    });
    let debit = 0n;
    let credit = 0n;
    for (const g of grouped) {
      if (g.direction === EntryDirection.DEBIT) debit = g._sum.amount ?? 0n;
      if (g.direction === EntryDirection.CREDIT) credit = g._sum.amount ?? 0n;
    }
    return debit - credit;
  }

  /**
   * Atomic two-leg post: amount moves from `creditWalletId` to `debitWalletId`.
   * Throws if the credited (paying) wallet would go negative.
   * Set creditWalletId = null when funds enter the system from outside (top-up):
   * we then post against a SYSTEM wallet to keep the books balanced.
   */
  async post(params: {
    type: TxnType;
    amount: bigint;
    debitWalletId: string;          // wallet receiving the money
    creditWalletId: string;         // wallet paying — use SYSTEM wallet for top-ups
    description?: string;
    category?: string;
    externalRef?: string;
  }) {
    if (params.amount <= 0n) {
      throw new BadRequestException('Amount must be positive');
    }

    return this.prisma.$transaction(async (tx) => {
      // Re-check balance inside the transaction to avoid TOCTOU.
      // (For high concurrency, use SELECT ... FOR UPDATE on a wallet row.)
      const creditWallet = await tx.wallet.findUnique({
        where: { id: params.creditWalletId },
      });
      if (!creditWallet) throw new BadRequestException('Source wallet missing');
      if (creditWallet.isFrozen) throw new ForbiddenException('Source wallet frozen');

      if (creditWallet.type !== 'SYSTEM') {
        const balance = await this.balanceInTx(tx, params.creditWalletId);
        if (balance < params.amount) {
          throw new BadRequestException('Insufficient funds');
        }
      }

      const debitWallet = await tx.wallet.findUnique({
        where: { id: params.debitWalletId },
      });
      if (!debitWallet) throw new BadRequestException('Destination wallet missing');
      if (debitWallet.isFrozen) throw new ForbiddenException('Destination wallet frozen');

      const transaction = await tx.transaction.create({
        data: {
          type: params.type,
          status: 'COMPLETED',
          amount: params.amount,
          description: params.description,
          category: params.category,
          externalRef: params.externalRef,
          completedAt: new Date(),
          entries: {
            create: [
              {
                walletId: params.debitWalletId,
                direction: EntryDirection.DEBIT,
                amount: params.amount,
              },
              {
                walletId: params.creditWalletId,
                direction: EntryDirection.CREDIT,
                amount: params.amount,
              },
            ],
          },
        },
        include: { entries: true },
      });

      // Sanity check — debits must equal credits on every transaction.
      const totals = transaction.entries.reduce(
        (acc, e) => {
          if (e.direction === EntryDirection.DEBIT) acc.debit += e.amount;
          else acc.credit += e.amount;
          return acc;
        },
        { debit: 0n, credit: 0n },
      );
      if (totals.debit !== totals.credit) {
        throw new Error('Ledger imbalance — refusing to commit');
      }

      return transaction;
    });
  }

  private async balanceInTx(
    tx: Prisma.TransactionClient,
    walletId: string,
  ): Promise<bigint> {
    const grouped = await tx.ledgerEntry.groupBy({
      by: ['direction'],
      where: { walletId, transaction: { status: 'COMPLETED' } },
      _sum: { amount: true },
    });
    let debit = 0n;
    let credit = 0n;
    for (const g of grouped) {
      if (g.direction === EntryDirection.DEBIT) debit = g._sum.amount ?? 0n;
      if (g.direction === EntryDirection.CREDIT) credit = g._sum.amount ?? 0n;
    }
    return debit - credit;
  }

  async listEntries(walletId: string, limit = 50) {
    return this.prisma.ledgerEntry.findMany({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { transaction: true },
    });
  }

  /**
   * Returns the SYSTEM cash-in wallet, creating it on first call.
   * All top-ups credit this wallet (i.e. money flows OUT of system into user).
   */
  async getSystemCashInWallet() {
    const existing = await this.prisma.wallet.findFirst({
      where: { type: 'SYSTEM', name: 'SYSTEM:CASH_IN' },
    });
    if (existing) return existing;

    // Need a system "owner" user. Use a sentinel.
    const sysUser = await this.prisma.user.upsert({
      where: { email: 'system@mores-hub.local' },
      update: {},
      create: {
        googleSub: 'system-cashin',
        email: 'system@mores-hub.local',
        name: 'SYSTEM',
        kycTier: 'ENHANCED',
      },
    });
    return this.prisma.wallet.create({
      data: {
        ownerId: sysUser.id,
        name: 'SYSTEM:CASH_IN',
        type: 'SYSTEM',
      },
    });
  }
}
