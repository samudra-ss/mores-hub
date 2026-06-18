import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuditService } from './audit.service';

const DUAL_APPROVAL_THRESHOLD = 50_000_000n; // IDR 50M

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  async assertAdmin(userId: string, atLeast: AdminRole = 'SUPPORT') {
    const admin = await this.prisma.admin.findUnique({ where: { userId } });
    if (!admin) throw new ForbiddenException('Not an admin');
    const order: AdminRole[] = ['SUPPORT', 'OPERATIONS', 'TREASURY', 'SUPERADMIN'];
    if (order.indexOf(admin.role) < order.indexOf(atLeast)) {
      throw new ForbiddenException(`Requires ${atLeast} role`);
    }
    return admin;
  }

  async listUsers(actor: string, limit = 100) {
    await this.assertAdmin(actor, 'SUPPORT');
    return this.prisma.user.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        name: true,
        kycTier: true,
        isActive: true,
        createdAt: true,
      },
    });
  }

  async freezeWallet(actor: string, walletId: string, reason: string) {
    await this.assertAdmin(actor, 'OPERATIONS');
    const wallet = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    const updated = await this.prisma.wallet.update({
      where: { id: walletId },
      data: { isFrozen: true },
    });
    await this.audit.record({
      actorUserId: actor,
      action: 'wallet.freeze',
      target: walletId,
      payload: { reason },
    });
    return updated;
  }

  /**
   * Manual ledger adjustment (e.g. dispute refund). Above the threshold,
   * requires a second admin's approval before execution.
   */
  async requestLedgerAdjustment(
    actor: string,
    input: {
      debitWalletId: string;
      creditWalletId: string;
      amount: bigint;
      reason: string;
    },
  ) {
    await this.assertAdmin(actor, 'TREASURY');

    if (input.amount < DUAL_APPROVAL_THRESHOLD) {
      const txn = await this.ledger.post({
        type: 'ADMIN_ADJUSTMENT',
        amount: input.amount,
        debitWalletId: input.debitWalletId,
        creditWalletId: input.creditWalletId,
        description: `Admin adjustment: ${input.reason}`,
        category: 'admin',
      });
      await this.audit.record({
        actorUserId: actor,
        action: 'ledger.adjust',
        target: txn.id,
        payload: { ...input, amount: input.amount.toString() },
      });
      return { executedImmediately: true, transactionId: txn.id };
    }

    const approval = await this.prisma.dualApproval.create({
      data: {
        action: 'ledger.adjust',
        payload: { ...input, amount: input.amount.toString() } as any,
        requestedBy: actor,
        approvals: [actor],
      },
    });
    await this.audit.record({
      actorUserId: actor,
      action: 'dualApproval.request',
      target: approval.id,
      payload: { ...input, amount: input.amount.toString() },
    });
    return { executedImmediately: false, approvalId: approval.id };
  }

  async approveDualAction(actor: string, approvalId: string) {
    await this.assertAdmin(actor, 'TREASURY');
    const approval = await this.prisma.dualApproval.findUnique({
      where: { id: approvalId },
    });
    if (!approval) throw new NotFoundException('Approval not found');
    if (approval.status !== 'PENDING')
      throw new ForbiddenException('Already resolved');
    if (approval.approvals.includes(actor))
      throw new ForbiddenException('You already approved');

    const next = [...approval.approvals, actor];
    if (next.length < approval.requiredCount) {
      const updated = await this.prisma.dualApproval.update({
        where: { id: approvalId },
        data: { approvals: next },
      });
      await this.audit.record({
        actorUserId: actor,
        action: 'dualApproval.approve',
        target: approvalId,
        payload: { approvals: next.length, required: approval.requiredCount },
      });
      return { status: updated.status, approvals: next.length };
    }

    // Threshold met — execute.
    const payload = approval.payload as any;
    const txn = await this.ledger.post({
      type: 'ADMIN_ADJUSTMENT',
      amount: BigInt(payload.amount),
      debitWalletId: payload.debitWalletId,
      creditWalletId: payload.creditWalletId,
      description: `Admin adjustment (dual): ${payload.reason}`,
      category: 'admin',
    });
    await this.prisma.dualApproval.update({
      where: { id: approvalId },
      data: {
        approvals: next,
        status: 'EXECUTED',
        resolvedAt: new Date(),
      },
    });
    await this.audit.record({
      actorUserId: actor,
      action: 'dualApproval.execute',
      target: txn.id,
      payload,
    });
    return { status: 'EXECUTED' as const, transactionId: txn.id };
  }
}
