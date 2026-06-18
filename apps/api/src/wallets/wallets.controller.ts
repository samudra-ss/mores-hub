import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { AccessRole, WalletType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { WalletsService } from './wallets.service';
import { LedgerService } from '../ledger/ledger.service';

class CreateWalletDto {
  @IsString() name!: string;
  @IsOptional() @IsEnum(WalletType) type?: WalletType;
}

class GrantAccessDto {
  @IsString() userId!: string;
  @IsEnum(AccessRole) role!: AccessRole;
}

class TransferDto {
  @IsString() toWalletId!: string;
  @IsInt() @Min(1) amount!: number;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() category?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly wallets: WalletsService,
    private readonly ledger: LedgerService,
  ) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.wallets.listForUser(userId);
  }

  @Post()
  create(@CurrentUser('id') userId: string, @Body() body: CreateWalletDto) {
    return this.wallets.create(userId, body.name, body.type);
  }

  @Get(':id')
  async get(@Param('id') walletId: string, @CurrentUser('id') userId: string) {
    const { wallet, role } = await this.wallets.getOrThrow(walletId, userId);
    const balance = await this.ledger.getBalance(walletId);
    const recent = await this.ledger.listEntries(walletId, 25);
    return {
      ...wallet,
      role,
      balance: balance.toString(),
      recent: recent.map((e) => ({
        id: e.id,
        direction: e.direction,
        amount: e.amount.toString(),
        type: e.transaction.type,
        description: e.transaction.description,
        category: e.transaction.category,
        createdAt: e.createdAt,
      })),
    };
  }

  @Post(':id/access')
  grant(
    @Param('id') walletId: string,
    @CurrentUser('id') userId: string,
    @Body() body: GrantAccessDto,
  ) {
    return this.wallets.grantAccess(walletId, userId, body.userId, body.role);
  }

  @Post(':id/transfer')
  transfer(
    @Param('id') walletId: string,
    @CurrentUser('id') userId: string,
    @Body() body: TransferDto,
  ) {
    return this.wallets.transfer({
      fromUserId: userId,
      fromWalletId: walletId,
      toWalletId: body.toWalletId,
      amount: BigInt(body.amount),
      description: body.description,
      category: body.category,
    });
  }
}
