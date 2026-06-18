import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AccessRole, WalletType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Wallet visibility rule (#7 from product spec):
   * a wallet is only visible to its owner and accounts on its access list.
   */
  async listForUser(userId: string) {
    const access = await this.prisma.walletAccess.findMany({
      where: { userId },
      include: { wallet: true },
    });
    return Promise.all(
      access.map(async (a) => ({
        id: a.wallet.id,
        name: a.wallet.name,
        type: a.wallet.type,
        currency: a.wallet.currency,
        role: a.role,
        isFrozen: a.wallet.isFrozen,
        balance: (await this.ledger.getBalance(a.wallet.id)).toString(),
      })),
    );
  }

  async getOrThrow(walletId: string, userId: string) {
    const access = await this.prisma.walletAccess.findUnique({
      where: { walletId_userId: { walletId, userId } },
    });
    if (!access) throw new NotFoundException('Wallet not found');
    const wallet = await this.prisma.wallet.findUniqueOrThrow({
      where: { id: walletId },
    });
    return { wallet, role: access.role };
  }

  async assertCanSpend(walletId: string, userId: string) {
    const { role, wallet } = await this.getOrThrow(walletId, userId);
    if (wallet.isFrozen) throw new ForbiddenException('Wallet frozen');
    if (role === AccessRole.VIEWER) {
      throw new ForbiddenException('View-only access on this wallet');
    }
  }

  async create(userId: string, name: string, type: WalletType = 'PERSONAL') {
    return this.prisma.wallet.create({
      data: {
        ownerId: userId,
        name,
        type,
        access: { create: { userId, role: 'OWNER' } },
      },
    });
  }

  async grantAccess(
    walletId: string,
    granterId: string,
    granteeUserId: string,
    role: AccessRole,
  ) {
    const { role: granterRole } = await this.getOrThrow(walletId, granterId);
    if (granterRole !== AccessRole.OWNER) {
      throw new ForbiddenException('Only the owner can grant access');
    }
    return this.prisma.walletAccess.upsert({
      where: { walletId_userId: { walletId, userId: granteeUserId } },
      update: { role },
      create: { walletId, userId: granteeUserId, role },
    });
  }

  async transfer(params: {
    fromUserId: string;
    fromWalletId: string;
    toWalletId: string;
    amount: bigint;
    description?: string;
    category?: string;
  }) {
    await this.assertCanSpend(params.fromWalletId, params.fromUserId);
    return this.ledger.post({
      type: 'TRANSFER',
      amount: params.amount,
      debitWalletId: params.toWalletId,
      creditWalletId: params.fromWalletId,
      description: params.description,
      category: params.category,
    });
  }
}
