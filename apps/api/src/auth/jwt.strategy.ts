import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET ?? 'dev-secret-change-me',
    });
  }

  async validate(payload: { sub: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user || !user.isActive) throw new UnauthorizedException();
    return user;
  }
}
