import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: the gateway webhook verifies an HMAC over the raw request body
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: true, credentials: true });

  const mode = process.env.PAYMENT_MODE ?? 'mock';
  if (mode === 'production' && !process.env.BI_PJP_LICENSE_NO) {
    Logger.error(
      'PAYMENT_MODE=production but BI_PJP_LICENSE_NO is not set. Refusing to start.',
      'Bootstrap',
    );
    process.exit(1);
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`MORES-HUB API listening on :${port} (PAYMENT_MODE=${mode})`, 'Bootstrap');
}

bootstrap();
