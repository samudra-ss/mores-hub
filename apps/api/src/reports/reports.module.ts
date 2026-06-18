import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { WalletsModule } from '../wallets/wallets.module';

@Module({
  imports: [WalletsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
