import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsInt, IsString, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AdminService } from './admin.service';
import { AuditService } from './audit.service';

class FreezeWalletDto {
  @IsString() reason!: string;
}

class AdjustDto {
  @IsString() debitWalletId!: string;
  @IsString() creditWalletId!: string;
  @IsInt() @Min(1) amount!: number;
  @IsString() reason!: string;
}

@UseGuards(JwtAuthGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly audit: AuditService,
  ) {}

  @Get('users')
  users(@CurrentUser('id') actor: string) {
    return this.admin.listUsers(actor);
  }

  @Post('wallets/:id/freeze')
  freeze(
    @CurrentUser('id') actor: string,
    @Param('id') walletId: string,
    @Body() body: FreezeWalletDto,
  ) {
    return this.admin.freezeWallet(actor, walletId, body.reason);
  }

  @Post('ledger/adjust')
  adjust(@CurrentUser('id') actor: string, @Body() body: AdjustDto) {
    return this.admin.requestLedgerAdjustment(actor, {
      debitWalletId: body.debitWalletId,
      creditWalletId: body.creditWalletId,
      amount: BigInt(body.amount),
      reason: body.reason,
    });
  }

  @Post('approvals/:id')
  approve(
    @CurrentUser('id') actor: string,
    @Param('id') approvalId: string,
  ) {
    return this.admin.approveDualAction(actor, approvalId);
  }

  @Get('audit/verify')
  async verifyAudit(@CurrentUser('id') actor: string) {
    await this.admin.assertAdmin(actor, 'SUPERADMIN');
    const tampered = await this.audit.verifyChain();
    return tampered ? { ok: false, tamperedRowId: tampered } : { ok: true };
  }
}
