import { Module } from '@nestjs/common';
import { QrisController } from './qris.controller';
import { QrisService } from './qris.service';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletsModule } from '../wallets/wallets.module';

@Module({
  imports: [LedgerModule, WalletsModule],
  controllers: [QrisController],
  providers: [QrisService],
})
export class QrisModule {}
