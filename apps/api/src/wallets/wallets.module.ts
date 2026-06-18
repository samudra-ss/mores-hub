import { Module } from '@nestjs/common';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
