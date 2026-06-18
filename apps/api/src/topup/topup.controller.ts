import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsEnum, IsInt, IsString, Min } from 'class-validator';
import { IdBank } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { TopupService } from './topup.service';

class CreateTopupDto {
  @IsString() walletId!: string;
  @IsEnum(IdBank) bank!: IdBank;
  @IsInt() @Min(10000) amount!: number;
}

class WebhookDto {
  @IsString() providerRef!: string;
}

@Controller('topup')
export class TopupController {
  constructor(private readonly topup: TopupService) {}

  @UseGuards(JwtAuthGuard)
  @Post('orders')
  async create(@CurrentUser('id') userId: string, @Body() body: CreateTopupDto) {
    const order = await this.topup.createOrder({
      userId,
      walletId: body.walletId,
      bank: body.bank,
      amount: BigInt(body.amount),
    });
    return {
      id: order.id,
      bank: order.bank,
      vaNumber: order.vaNumber,
      amount: order.amount.toString(),
      expiresAt: order.expiresAt,
      // Mock-mode helper so the mobile dev can simulate a paid VA without a bank
      mockSettleHint:
        process.env.PAYMENT_MODE === 'mock'
          ? { method: 'POST', url: '/topup/webhook', body: { providerRef: order.providerRef } }
          : undefined,
    };
  }

  /**
   * In real life this is signed and called by the bank/aggregator.
   * In mock mode we leave it open so the dev can simulate a settled VA.
   */
  @Post('webhook')
  async webhook(@Body() body: WebhookDto) {
    const order = await this.topup.settleByProviderRef(body.providerRef);
    return { ok: true, status: order.status };
  }
}
