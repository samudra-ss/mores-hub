import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly google = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Verifies a Google ID token (sent from mobile/web after Google sign-in)
   * and creates the user + a default personal wallet on first login.
   */
  async loginWithGoogle(idToken: string) {
    const ticket = await this.google.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      throw new UnauthorizedException('Invalid Google token');
    }

    let user = await this.prisma.user.findUnique({
      where: { googleSub: payload.sub },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          googleSub: payload.sub,
          email: payload.email,
          name: payload.name ?? payload.email.split('@')[0],
          avatarUrl: payload.picture,
          kycTier: 'BASIC', // Google email is verified
        },
      });
      // Bootstrap a personal wallet so the user always has one to receive into.
      await this.ledger.bootstrapWallet(user.id, 'Personal');
    }

    if (!user.isActive) {
      throw new ForbiddenException('Account disabled');
    }

    return { user, accessToken: this.signToken(user.id) };
  }

  signToken(userId: string) {
    return this.jwt.sign({ sub: userId });
  }

  async setPin(userId: string, pin: string) {
    if (!/^\d{6}$/.test(pin)) {
      throw new ForbiddenException('PIN must be 6 digits');
    }
    const pinHash = await argon2.hash(pin, { type: argon2.argon2id });
    await this.prisma.user.update({
      where: { id: userId },
      data: { pinHash, pinFailures: 0, pinLockedAt: null },
    });
  }

  async verifyPin(userId: string, pin: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.pinHash) throw new ForbiddenException('PIN not set');

    if (
      user.pinLockedAt &&
      Date.now() - user.pinLockedAt.getTime() < PIN_LOCKOUT_MS
    ) {
      throw new ForbiddenException('PIN locked — try again later');
    }

    const ok = await argon2.verify(user.pinHash, pin);
    if (!ok) {
      const failures = user.pinFailures + 1;
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          pinFailures: failures,
          pinLockedAt: failures >= PIN_MAX_ATTEMPTS ? new Date() : null,
        },
      });
      throw new UnauthorizedException('Wrong PIN');
    }

    if (user.pinFailures > 0) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { pinFailures: 0, pinLockedAt: null },
      });
    }
    return true;
  }
}
