import { Global, Module } from '@nestjs/common';
import { MockProvider } from './mock.provider';

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

@Global()
@Module({
  providers: [
    MockProvider,
    {
      provide: PAYMENT_PROVIDER,
      useFactory: (mock: MockProvider) => {
        const mode = process.env.PAYMENT_MODE ?? 'mock';
        if (mode === 'mock') return mock;
        // In sandbox/production wire up XenditProvider / MidtransProvider here.
        throw new Error(`PAYMENT_MODE=${mode} not implemented in this scaffold`);
      },
      inject: [MockProvider],
    },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentsModule {}
