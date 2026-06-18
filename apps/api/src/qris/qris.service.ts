import { Injectable, NotFoundException } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WalletsService } from '../wallets/wallets.service';

/**
 * QRIS payload generator (EMVCo TLV per QRIS spec).
 *
 *   Each tag is "ID(2 chars) + LEN(2 chars) + VALUE", concatenated, then a
 *   CRC16-CCITT (XMODEM, polynomial 0x1021, init 0xFFFF) appended as tag 63.
 *
 *   In a real merchant aggregator deployment the Merchant ID + Acquirer ID
 *   come from your acquiring bank's onboarding, NOT made up. We use a mock
 *   ID here so dev QRs render correctly but won't be honored by any real
 *   QRIS-supporting wallet (intentional — sandbox only).
 */
@Injectable()
export class QrisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletsService,
  ) {}

  async generateStatic(walletId: string, userId: string) {
    await this.wallets.getOrThrow(walletId, userId);
    const payload = this.buildPayload({ walletId, amount: null });
    const imageDataUrl = await QRCode.toDataURL(payload);
    return this.prisma.qrCode.create({
      data: {
        walletId,
        type: 'STATIC_MPM',
        payload,
        imageDataUrl,
      },
    });
  }

  async generateDynamic(walletId: string, userId: string, amount: bigint) {
    await this.wallets.getOrThrow(walletId, userId);
    const payload = this.buildPayload({ walletId, amount });
    const imageDataUrl = await QRCode.toDataURL(payload);
    return this.prisma.qrCode.create({
      data: {
        walletId,
        type: 'DYNAMIC_MPM',
        amount,
        payload,
        imageDataUrl,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
  }

  /**
   * Pay a previously-generated QR. In production the payload itself is the
   * input (scanned by the camera) and we parse the merchant ID out of it; in
   * mock-mode we look up the QrCode row by id for simplicity.
   */
  async pay(params: {
    payerUserId: string;
    payerWalletId: string;
    qrCodeId: string;
    amount?: bigint; // required for STATIC_MPM, ignored for DYNAMIC
  }) {
    await this.wallets.assertCanSpend(params.payerWalletId, params.payerUserId);
    const qr = await this.prisma.qrCode.findUnique({ where: { id: params.qrCodeId } });
    if (!qr) throw new NotFoundException('QR not found');
    if (qr.expiresAt && qr.expiresAt < new Date()) {
      throw new NotFoundException('QR expired');
    }
    const amount = qr.amount ?? params.amount;
    if (!amount) throw new NotFoundException('Amount required for static QR');

    return this.ledger.post({
      type: 'QRIS_PAYMENT',
      amount,
      debitWalletId: qr.walletId,         // payee
      creditWalletId: params.payerWalletId, // payer
      description: `QRIS payment`,
      category: 'qris',
    });
  }

  // ------------------------------------------------------------------
  // EMVCo TLV builder (subset sufficient for QRIS MPM)
  // ------------------------------------------------------------------
  private buildPayload(input: { walletId: string; amount: bigint | null }) {
    const merchantId = process.env.QRIS_MERCHANT_ID ?? 'ID1024000000000';
    const merchantName = (process.env.QRIS_MERCHANT_NAME ?? 'MORESHUB DEMO').slice(0, 25);
    const merchantCity = (process.env.QRIS_MERCHANT_CITY ?? 'JAKARTA').slice(0, 15);

    const tlv = (id: string, value: string) =>
      `${id}${value.length.toString().padStart(2, '0')}${value}`;

    // Merchant Account Information for QRIS (tag 51 — domestic)
    const acquirerInfo =
      tlv('00', 'ID.CO.QRIS.WWW') +
      tlv('01', merchantId) +
      tlv('02', `MORESHUB-${input.walletId.slice(0, 8)}`) + // sub-merchant id
      tlv('03', 'UME'); // Usaha Mikro/Kecil/Menengah category

    let payload =
      tlv('00', '01') +                              // Payload format indicator
      tlv('01', input.amount ? '12' : '11') +        // 11=static, 12=dynamic
      tlv('51', acquirerInfo) +
      tlv('52', '5411') +                            // MCC — generic merchant
      tlv('53', '360') +                             // currency: 360 = IDR
      tlv('58', 'ID') +                              // country
      tlv('59', merchantName) +
      tlv('60', merchantCity);

    if (input.amount) {
      payload += tlv('54', input.amount.toString()); // transaction amount
    }

    payload += '6304'; // CRC tag header — value computed over everything before
    const crc = this.crc16ccitt(payload);
    return payload + crc;
  }

  private crc16ccitt(s: string): string {
    let crc = 0xffff;
    for (let i = 0; i < s.length; i++) {
      crc ^= s.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) {
        crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
        crc &= 0xffff;
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }
}
