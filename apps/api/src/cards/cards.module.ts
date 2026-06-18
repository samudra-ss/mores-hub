import { Module } from '@nestjs/common';
import { CardsController } from './cards.controller';
import { CardsService } from './cards.service';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletsModule } from '../wallets/wallets.module';

@Module({
  imports: [LedgerModule, WalletsModule],
  controllers: [CardsController],
  providers: [CardsService],
})
export class CardsModule {}
