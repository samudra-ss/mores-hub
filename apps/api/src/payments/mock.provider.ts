import { Injectable } from '@nestjs/common';
import { nanoid } from 'nanoid';
import { IdBank } from '@prisma/client';
import {
  PaymentProvider,
  CreateVaInput,
  CreateVaResult,
  IssueCardInput,
  IssueCardResult,
} from './provider.interface';

/**
 * MockProvider — local stand-in for Xendit / Midtrans / DOKU.
 *
 *   - createVirtualAccount returns a deterministic-looking VA number per bank
 *   - issueVirtualCard returns a fake PAN token + last4 + expiry
 *   - In sandbox/production, swap for the real SDK call (only this file changes)
 */
@Injectable()
export class MockProvider implements PaymentProvider {
  readonly name = 'mock';

  // Real bank prefixes (3 digits) used by aggregators in Indonesia. Mock only.
  private readonly bankPrefix: Record<IdBank, string> = {
    BCA: '014',
    BNI: '009',
    BRI: '002',
    MANDIRI: '008',
    PERMATA: '013',
    CIMB: '022',
    BSI: '451',
    DANAMON: '011',
  };

  async createVirtualAccount(input: CreateVaInput): Promise<CreateVaResult> {
    const prefix = this.bankPrefix[input.bank];
    const random = String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
    return {
      vaNumber: `${prefix}${random}`,
      providerRef: `mock_va_${nanoid(12)}`,
    };
  }

  async issueVirtualCard(_input: IssueCardInput): Promise<IssueCardResult> {
    const last4 = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const now = new Date();
    return {
      panToken: `tok_${nanoid(20)}`,
      last4,
      expMonth: now.getMonth() + 1,
      expYear: now.getFullYear() + 4,
    };
  }
}
