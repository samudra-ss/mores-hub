import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { IdBank } from '@prisma/client';

export const CATEGORIES = [
  'meals',
  'transport',
  'lodging',
  'supplies',
  'events',
  'entertainment',
  'communication',
  'general',
] as const;

export class CreateRequestDto {
  @IsIn(['REIMBURSEMENT', 'VENDOR_PAYMENT'])
  kind!: 'REIMBURSEMENT' | 'VENDOR_PAYMENT';

  // multipart form fields arrive as strings — @Type coerces before validation
  @Type(() => Number) @IsInt() @Min(1)
  amount!: number;

  @IsIn(CATEGORIES as readonly string[])
  category!: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @IsOptional() @IsString() @MaxLength(120)
  merchant?: string; // required for VENDOR_PAYMENT — checked in service

  @IsIn(Object.values(IdBank))
  bankCode!: IdBank;

  @IsString() @Matches(/^\d{6,20}$/, { message: 'bankAccount must be 6-20 digits' })
  bankAccount!: string;

  @IsOptional() @IsString() @MaxLength(120)
  bankHolder?: string;
}

export class DecideDto {
  @IsIn(['approve', 'reject'])
  action!: 'approve' | 'reject';

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

export class EnrollAgentDto {
  @IsString()
  userId!: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  monthlyQuota?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  perTxnLimit?: number;
}

export class TopupDto {
  @Type(() => Number) @IsInt() @Min(1)
  amount!: number;

  @IsOptional() @IsString() @MaxLength(200)
  note?: string;
}

export class GatewayWebhookDto {
  @IsString()
  gatewayRef!: string;

  @IsIn(['settled', 'failed'])
  status!: 'settled' | 'failed';
}
