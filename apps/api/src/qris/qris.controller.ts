import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { QrisService } from './qris.service';

class StaticDto {
  @IsString() walletId!: string;
}

class DynamicDto {
  @IsString() walletId!: string;
  @IsInt() @Min(1) amount!: number;
}

class PayDto {
  @IsString() payerWalletId!: string;
  @IsString() qrCodeId!: string;
  @IsOptional() @IsInt() @Min(1) amount?: number;
}

@UseGuards(JwtAuthGuard)
@Controller('qris')
export class QrisController {
  constructor(private readonly qris: QrisService) {}

  @Post('static')
  static_(@CurrentUser('id') userId: string, @Body() body: StaticDto) {
    return this.qris.generateStatic(body.walletId, userId);
  }

  @Post('dynamic')
  dynamic(@CurrentUser('id') userId: string, @Body() body: DynamicDto) {
    return this.qris.generateDynamic(body.walletId, userId, BigInt(body.amount));
  }

  @Post('scan')
  pay(@CurrentUser('id') userId: string, @Body() body: PayDto) {
    return this.qris.pay({
      payerUserId: userId,
      payerWalletId: body.payerWalletId,
      qrCodeId: body.qrCodeId,
      amount: body.amount ? BigInt(body.amount) : undefined,
    });
  }
}
