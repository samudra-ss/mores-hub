import { IdBank } from '@prisma/client';

export interface CreateVaInput {
  bank: IdBank;
  amount: bigint;
  externalRef: string; // our top-up order id
  customerName: string;
  expiresAt: Date;
}

export interface CreateVaResult {
  vaNumber: string;
  providerRef: string;
}

export interface IssueCardInput {
  userId: string;
  brand: 'VISA' | 'MASTERCARD' | 'GPN';
}

export interface IssueCardResult {
  panToken: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export interface PaymentProvider {
  readonly name: string;
  createVirtualAccount(input: CreateVaInput): Promise<CreateVaResult>;
  issueVirtualCard(input: IssueCardInput): Promise<IssueCardResult>;
}
