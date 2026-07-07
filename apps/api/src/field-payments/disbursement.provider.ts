import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

export interface CreateDisbursementInput {
  idempotencyKey: string; // provider dedupes retries on this
  amount: bigint;
  bankCode: string;
  bankAccount: string;
  holder: string;
}

export interface DisbursementProvider {
  readonly name: string;
  /** Starts a payout. Settlement arrives later via webhook. */
  createDisbursement(input: CreateDisbursementInput): Promise<{ gatewayRef: string }>;
}

export const DISBURSEMENT_PROVIDER = 'DISBURSEMENT_PROVIDER';

/** HMAC-SHA256 webhook signing — the scheme Xendit/Midtrans callbacks use. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = process.env.GATEWAY_WEBHOOK_SECRET ?? 'mock-callback-secret-change-me';
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = Buffer.from(signature ?? '', 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Mock gateway, same demo semantics as the apps/payments prototype:
 *   - settles ~4 s after creation through the SAME code path a real webhook
 *     takes (DisbursementService.settle is idempotent);
 *   - a bank account starting with "000" always FAILS, to demo the
 *     failure -> ledger reversal -> retry flow.
 *
 * Going live = an XenditProvider implementing DisbursementProvider; nothing
 * else in the module changes.
 */
@Injectable()
export class MockDisbursementProvider implements DisbursementProvider {
  readonly name = 'mock';
  private readonly logger = new Logger(MockDisbursementProvider.name);

  /** Wired by FieldPaymentsModule.onModuleInit to DisbursementService.settle. */
  onSettle: ((gatewayRef: string, ok: boolean) => Promise<unknown>) | null = null;

  async createDisbursement(input: CreateDisbursementInput) {
    const gatewayRef = 'mock-disb-' + randomBytes(5).toString('hex');
    const ok = !input.bankAccount.startsWith('000');
    setTimeout(() => {
      this.onSettle?.(gatewayRef, ok).catch((err) =>
        this.logger.error(`mock settle ${gatewayRef} failed: ${err.message}`),
      );
    }, 4_000);
    return { gatewayRef };
  }
}
