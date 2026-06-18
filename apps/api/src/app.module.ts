import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WalletsModule } from './wallets/wallets.module';
import { LedgerModule } from './ledger/ledger.module';
import { TopupModule } from './topup/topup.module';
import { QrisModule } from './qris/qris.module';
import { CardsModule } from './cards/cards.module';
import { ReportsModule } from './reports/reports.module';
import { AdminModule } from './admin/admin.module';
import { ComplianceModule } from './compliance/compliance.module';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    PrismaModule,
    PaymentsModule,
    ComplianceModule,
    AuthModule,
    UsersModule,
    WalletsModule,
    LedgerModule,
    TopupModule,
    QrisModule,
    CardsModule,
    ReportsModule,
    AdminModule,
  ],
})
export class AppModule {}
