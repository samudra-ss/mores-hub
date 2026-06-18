import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { ReportsService } from './reports.service';

@UseGuards(JwtAuthGuard)
@Controller('wallets/:id/report')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  expenses(
    @Param('id') walletId: string,
    @CurrentUser('id') userId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86_400_000);
    const toDate = to ? new Date(to) : new Date();
    return this.reports.walletExpenses(walletId, userId, { from: fromDate, to: toDate });
  }

  @Get('by-person')
  byPerson(
    @Param('id') walletId: string,
    @CurrentUser('id') userId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86_400_000);
    const toDate = to ? new Date(to) : new Date();
    return this.reports.sharedWalletByPerson(walletId, userId, { from: fromDate, to: toDate });
  }
}
