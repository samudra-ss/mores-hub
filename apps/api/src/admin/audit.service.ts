import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Append-only audit log with a hash chain. Each row's `rowHash` includes the
 * previous row's hash, so silent tampering with the table is detectable on
 * the next reconciliation pass.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: {
    actorUserId: string | null;
    action: string;
    target?: string;
    payload: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
  }) {
    const last = await this.prisma.auditLog.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { rowHash: true },
    });
    const prevHash = last?.rowHash ?? null;

    const body = JSON.stringify({
      actorUserId: input.actorUserId,
      action: input.action,
      target: input.target ?? null,
      payload: input.payload,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      prevHash,
    });
    const rowHash = createHash('sha256').update(body).digest('hex');

    return this.prisma.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: input.action,
        target: input.target,
        payload: input.payload as any,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        prevHash,
        rowHash,
      },
    });
  }

  /** Verify the hash chain. Returns the id of the first tampered row, or null. */
  async verifyChain(): Promise<string | null> {
    const rows = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'asc' },
    });
    let prev: string | null = null;
    for (const r of rows) {
      const body = JSON.stringify({
        actorUserId: r.actorUserId,
        action: r.action,
        target: r.target,
        payload: r.payload,
        ipAddress: r.ipAddress,
        userAgent: r.userAgent,
        prevHash: prev,
      });
      const expected = createHash('sha256').update(body).digest('hex');
      if (expected !== r.rowHash) return r.id;
      prev = r.rowHash;
    }
    return null;
  }
}
