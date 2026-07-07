import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { SystemWalletsService } from './system-wallets.service';

/**
 * Nightly ledger reconciliation (02:00 Asia/Jakarta).
 *
 * Three invariants, the same ones the SQLite prototype verified by hand and
 * the migration's constraint trigger enforces per-transaction:
 *
 *   1. Globally, sum(DEBIT) === sum(CREDIT) across the whole ledger.
 *   2. No individual transaction has unbalanced entries (belt-and-braces on
 *      top of the deferred trigger — catches rows written before it existed).
 *   3. CLEARING_GATEWAY nets to exactly the amount still legitimately in
 *      flight (pending payouts). With nothing pending it must be zero.
 *
 * A failed run writes a SuspiciousActivity row so it surfaces in the
 * compliance queue — a broken ledger is treated as an incident, not a log line.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallets: SystemWalletsService,
  ) {}

  @Cron('0 2 * * *', { name: 'ledger-reconciliation', timeZone: 'Asia/Jakarta' })
  async nightly() {
    await this.run();
  }

  async run() {
    // 1. global debit/credit totals
    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['direction'],
      _sum: { amount: true },
    });
    let debits = 0n;
    let credits = 0n;
    for (const g of grouped) {
      if (g.direction === 'DEBIT') debits = g._sum.amount ?? 0n;
      if (g.direction === 'CREDIT') credits = g._sum.amount ?? 0n;
    }

    // 2. per-transaction balance sweep
    const unbalanced = await this.prisma.$queryRaw<Array<{ transactionId: string }>>`
      SELECT "transactionId"
      FROM "LedgerEntry"
      GROUP BY "transactionId"
      HAVING COALESCE(SUM(CASE WHEN "direction" = 'DEBIT'  THEN "amount" ELSE 0 END), 0)
          <> COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amount" ELSE 0 END), 0)
    `;

    // 3. clearing must equal exactly the pending in-flight amount
    const clearing = await this.wallets.clearingGateway();
    const clearingBalance = await this.ledger.getBalance(clearing.id);
    const pending = await this.prisma.gatewayPayout.aggregate({
      where: { status: 'PENDING' },
      _sum: { amount: true },
    });
    const expectedClearing = pending._sum.amount ?? 0n;

    const problems: string[] = [];
    if (debits !== credits) {
      problems.push(`global imbalance: debits ${debits} != credits ${credits}`);
    }
    if (unbalanced.length > 0) {
      problems.push(`${unbalanced.length} unbalanced transaction(s): ` +
        unbalanced.slice(0, 5).map((u) => u.transactionId).join(', '));
    }
    if (clearingBalance !== expectedClearing) {
      problems.push(
        `clearing ${clearingBalance} != in-flight ${expectedClearing}`,
      );
    }
    const ok = problems.length === 0;

    const run = await this.prisma.reconciliationRun.create({
      data: {
        ledgerDebits: debits,
        ledgerCredits: credits,
        clearingBalance,
        unbalancedTxns: unbalanced.length,
        ok,
        notes: ok ? null : problems.join(' | '),
      },
    });

    if (ok) {
      this.logger.log(
        `reconciliation OK — debits=credits=${debits}, clearing=${clearingBalance}`,
      );
    } else {
      this.logger.error(`RECONCILIATION FAILED: ${problems.join(' | ')}`);
      await this.prisma.suspiciousActivity.create({
        data: {
          reason: 'ledger_reconciliation_failed',
          meta: { runId: run.id, problems },
        },
      });
    }
    return run;
  }

  latest(take = 30) {
    return this.prisma.reconciliationRun.findMany({
      orderBy: { ranAt: 'desc' },
      take,
    });
  }
}
