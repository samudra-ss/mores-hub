import { Injectable } from '@nestjs/common';
import { Wallet } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Named SYSTEM wallets the field-payments money flows through:
 *
 *   CORPORATE_MAIN    the company float that funds everything
 *   CLEARING_GATEWAY  money in flight while the gateway disburses
 *   EXPENSE:<cat>     final expense recognition, one wallet per category
 *
 * Same pattern as LedgerService.getSystemCashInWallet — created lazily,
 * owned by the SYSTEM sentinel user.
 */
@Injectable()
export class SystemWalletsService {
  constructor(private readonly prisma: PrismaService) {}

  corporateMain(): Promise<Wallet> {
    return this.byName('SYSTEM:CORPORATE_MAIN');
  }

  clearingGateway(): Promise<Wallet> {
    return this.byName('SYSTEM:CLEARING_GATEWAY');
  }

  expense(category: string): Promise<Wallet> {
    return this.byName(`SYSTEM:EXPENSE:${category}`);
  }

  private async byName(name: string): Promise<Wallet> {
    const existing = await this.prisma.wallet.findFirst({
      where: { type: 'SYSTEM', name },
    });
    if (existing) return existing;

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
      data: { ownerId: sysUser.id, name, type: 'SYSTEM' },
    });
  }
}
