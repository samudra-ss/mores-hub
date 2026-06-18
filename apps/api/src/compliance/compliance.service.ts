import {
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { KycTier } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Enforces KYC tier limits + flags LTKT (cash transactions ≥ IDR 500M)
 * for PPATK reporting. Daily limits per tier are configurable via env so
 * compliance can tighten without a redeploy.
 */
@Injectable()
export class ComplianceService {
  constructor(private readonly prisma: PrismaService) {}

  private dailyLimit(tier: KycTier): bigint {
    switch (tier) {
      case 'UNVERIFIED':
        return 0n;
      case 'BASIC':
        return BigInt(process.env.DAILY_TXN_LIMIT_BASIC ?? 2_000_000);
      case 'VERIFIED':
        return BigInt(process.env.DAILY_TXN_LIMIT_VERIFIED ?? 20_000_000);
      case 'ENHANCED':
        return BigInt(process.env.DAILY_TXN_LIMIT_ENHANCED ?? 200_000_000);
    }
  }

  async assertWithinLimits(userId: string, addAmount: bigint) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const limit = this.dailyLimit(user.kycTier);
    if (limit === 0n) {
      throw new ForbiddenException(
        'Account not verified. Complete KYC to top up.',
      );
    }

    const since = new Date();
    since.setHours(0, 0, 0, 0);

    const dayTotal = await this.prisma.transaction.aggregate({
      where: {
        createdAt: { gte: since },
        status: 'COMPLETED',
        entries: {
          some: {
            wallet: { ownerId: userId },
            direction: 'DEBIT',
          },
        },
      },
      _sum: { amount: true },
    });

    const used = dayTotal._sum.amount ?? 0n;
    if (used + addAmount > limit) {
      throw new ForbiddenException(
        `Daily limit exceeded for tier ${user.kycTier} (limit IDR ${limit.toString()})`,
      );
    }
  }

  async checkLtkt(params: {
    userId: string;
    walletId: string;
    amount: bigint;
    reason: string;
  }) {
    const threshold = BigInt(process.env.LTKT_THRESHOLD_IDR ?? 500_000_000);
    if (params.amount < threshold) return;

    await this.prisma.suspiciousActivity.create({
      data: {
        userId: params.userId,
        walletId: params.walletId,
        reason: 'LTKT_threshold',
        amount: params.amount,
        meta: { trigger: params.reason, threshold: threshold.toString() },
      },
    });
    // In production: enqueue PPATK goAML report submission.
  }
}
