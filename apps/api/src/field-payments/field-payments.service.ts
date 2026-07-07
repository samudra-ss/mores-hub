import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FieldAgent, IdBank, RequestKind } from '@prisma/client';
import { customAlphabet } from 'nanoid';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { SystemWalletsService } from './system-wallets.service';
import { DisbursementService } from './disbursement.service';

const refId = customAlphabet('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 8);

/**
 * Field payments — port of the apps/payments Flask prototype.
 *
 * Semantics preserved exactly:
 *   - VENDOR_PAYMENT spends company money  -> counts against monthly quota
 *   - REIMBURSEMENT repays the agent       -> per-txn cap only, no quota
 *   - both need Finance approval; approval triggers the disbursement
 *   - budget allocation moves CORPORATE_MAIN -> agent quota wallet
 */
@Injectable()
export class FieldPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallets: SystemWalletsService,
    private readonly disbursement: DisbursementService,
  ) {}

  // ------------------------------------------------------------ role helpers

  /** Finance analog in the hub's Admin model: OPERATIONS and up. */
  async requireFinance(actorUserId: string) {
    const admin = await this.prisma.admin.findUnique({ where: { userId: actorUserId } });
    if (!admin || admin.role === 'SUPPORT') {
      throw new ForbiddenException('Requires OPERATIONS, TREASURY or SUPERADMIN');
    }
    return admin;
  }

  async requireAgent(userId: string): Promise<FieldAgent> {
    const agent = await this.prisma.fieldAgent.findUnique({ where: { userId } });
    if (!agent || !agent.isActive) {
      throw new ForbiddenException('No active field-agent profile');
    }
    return agent;
  }

  // ------------------------------------------------------------ enrollment

  async enrollAgent(actorUserId: string, params: {
    userId: string; monthlyQuota?: number; perTxnLimit?: number;
  }) {
    await this.requireFinance(actorUserId);
    const user = await this.prisma.user.findUnique({ where: { id: params.userId } });
    if (!user) throw new NotFoundException('User not found');
    if (await this.prisma.fieldAgent.findUnique({ where: { userId: user.id } })) {
      throw new ConflictException('Already a field agent');
    }
    const wallet = await this.prisma.wallet.create({
      data: {
        ownerId: user.id,
        name: `Field quota — ${user.name}`,
        type: 'PERSONAL',
        access: { create: { userId: user.id, role: 'OWNER' } },
      },
    });
    return this.prisma.fieldAgent.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        monthlyQuota: BigInt(params.monthlyQuota ?? 5_000_000),
        perTxnLimit: BigInt(params.perTxnLimit ?? 2_000_000),
      },
    });
  }

  /** Budget allocation: CORPORATE_MAIN -> agent quota wallet. */
  async topup(actorUserId: string, agentId: string, amount: bigint, note?: string) {
    await this.requireFinance(actorUserId);
    const agent = await this.prisma.fieldAgent.findUnique({ where: { id: agentId } });
    if (!agent || !agent.isActive) throw new NotFoundException('Agent not found or inactive');
    const corporate = await this.wallets.corporateMain();
    const txn = await this.ledger.post({
      type: 'BUDGET_ALLOCATION',
      amount,
      debitWalletId: agent.walletId,
      creditWalletId: corporate.id,
      description: note ?? 'Field budget allocation',
      category: 'general',
    });
    return { transactionId: txn.id, balance: await this.ledger.getBalance(agent.walletId) };
  }

  // ------------------------------------------------------------ limits

  private monthRange(month?: string): { gte: Date; lt: Date } {
    const now = new Date();
    const [y, m] = month
      ? month.split('-').map(Number)
      : [now.getFullYear(), now.getMonth() + 1];
    return { gte: new Date(y, m - 1, 1), lt: new Date(y, m, 1) };
  }

  /** Quota-relevant spend this month: vendor payments (not rejected/failed)
   *  plus QRIS payments made from the quota wallet. */
  async monthQuotaSpend(agent: FieldAgent, month?: string): Promise<bigint> {
    const createdAt = this.monthRange(month);
    const vendor = await this.prisma.paymentRequest.aggregate({
      where: {
        agentId: agent.id,
        kind: 'VENDOR_PAYMENT',
        status: { notIn: ['REJECTED', 'FAILED'] },
        createdAt,
      },
      _sum: { amount: true },
    });
    const qris = await this.prisma.ledgerEntry.aggregate({
      where: {
        walletId: agent.walletId,
        direction: 'CREDIT',
        createdAt,
        transaction: { type: 'QRIS_PAYMENT', status: 'COMPLETED' },
      },
      _sum: { amount: true },
    });
    return (vendor._sum.amount ?? 0n) + (qris._sum.amount ?? 0n);
  }

  async assertWithinLimits(agent: FieldAgent, amount: bigint, countsQuota: boolean) {
    if (amount <= 0n) throw new BadRequestException('Amount must be positive');
    if (amount > agent.perTxnLimit) {
      throw new BadRequestException(
        `Amount exceeds the per-transaction limit (${agent.perTxnLimit} IDR)`,
      );
    }
    if (countsQuota) {
      const spent = await this.monthQuotaSpend(agent);
      if (spent + amount > agent.monthlyQuota) {
        throw new BadRequestException(
          `Monthly quota exceeded (${spent} of ${agent.monthlyQuota} IDR used)`,
        );
      }
    }
  }

  // ------------------------------------------------------------ requests

  async createRequest(userId: string, params: {
    kind: RequestKind; amount: bigint; category: string; description?: string;
    merchant?: string; bankCode: IdBank; bankAccount: string; bankHolder?: string;
    receiptKey: string;
  }) {
    const agent = await this.requireAgent(userId);
    // reimbursements repay the agent's own money — no quota, cap still applies
    await this.assertWithinLimits(agent, params.amount, params.kind === 'VENDOR_PAYMENT');
    if (params.kind === 'VENDOR_PAYMENT' && !params.merchant) {
      throw new BadRequestException('Vendor name is required for vendor payments');
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const prefix = params.kind === 'REIMBURSEMENT' ? 'RB' : 'PO';
    return this.prisma.paymentRequest.create({
      data: {
        ref: `${prefix}-${refId()}`,
        agentId: agent.id,
        kind: params.kind,
        amount: params.amount,
        category: params.category,
        description: params.description,
        merchant: params.merchant,
        bankCode: params.bankCode,
        bankAccount: params.bankAccount,
        bankHolder: params.bankHolder ?? (params.merchant || user.name),
        receiptKey: params.receiptKey,
      },
    });
  }

  listMine(userId: string) {
    return this.prisma.paymentRequest.findMany({
      where: { agent: { userId } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async summary(userId: string) {
    const agent = await this.requireAgent(userId);
    const [balance, spend, recent] = await Promise.all([
      this.ledger.getBalance(agent.walletId),
      this.monthQuotaSpend(agent),
      this.prisma.paymentRequest.findMany({
        where: { agentId: agent.id },
        orderBy: { createdAt: 'desc' },
        take: 6,
      }),
    ]);
    return {
      balance,
      monthlyQuota: agent.monthlyQuota,
      perTxnLimit: agent.perTxnLimit,
      monthSpend: spend,
      recent,
    };
  }

  // ------------------------------------------------------------ approvals

  async pendingQueue(actorUserId: string) {
    await this.requireFinance(actorUserId);
    return this.prisma.paymentRequest.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: { agent: { include: { user: { select: { name: true, email: true } } } } },
    });
  }

  async decide(actorUserId: string, requestId: string, action: 'approve' | 'reject', note?: string) {
    await this.requireFinance(actorUserId);
    const req = await this.prisma.paymentRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'PENDING') {
      throw new ConflictException(`Already decided (${req.status})`);
    }

    if (action === 'reject') {
      if (!note?.trim()) throw new BadRequestException('A note is required when rejecting');
      return this.prisma.paymentRequest.update({
        where: { id: requestId },
        data: {
          status: 'REJECTED',
          decidedById: actorUserId,
          decidedAt: new Date(),
          decisionNote: note.trim(),
        },
      });
    }

    const approved = await this.prisma.paymentRequest.update({
      where: { id: requestId },
      data: {
        status: 'APPROVED',
        decidedById: actorUserId,
        decidedAt: new Date(),
        decisionNote: note?.trim() || null,
      },
    });
    const gatewayRef = await this.disbursement.start(approved);
    return { ...approved, status: 'DISBURSING' as const, gatewayRef };
  }

  // ------------------------------------------------------------ reporting

  async usage(actorUserId: string, month?: string) {
    await this.requireFinance(actorUserId);
    const agents = await this.prisma.fieldAgent.findMany({
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const createdAt = this.monthRange(month);
    return Promise.all(
      agents.map(async (a) => {
        const byKind = await this.prisma.paymentRequest.groupBy({
          by: ['kind'],
          where: {
            agentId: a.id,
            status: { notIn: ['REJECTED', 'FAILED'] },
            createdAt,
          },
          _sum: { amount: true },
        });
        const spend = await this.monthQuotaSpend(a, month);
        const sums = Object.fromEntries(byKind.map((k) => [k.kind, k._sum.amount ?? 0n]));
        return {
          agentId: a.id,
          name: a.user.name,
          email: a.user.email,
          isActive: a.isActive,
          balance: await this.ledger.getBalance(a.walletId),
          monthlyQuota: a.monthlyQuota,
          quotaSpend: spend,
          reimbursement: sums['REIMBURSEMENT'] ?? 0n,
          vendorPayment: sums['VENDOR_PAYMENT'] ?? 0n,
        };
      }),
    );
  }
}
