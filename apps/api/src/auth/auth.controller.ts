import { Body, Controller, Post, UseGuards, Req } from '@nestjs/common';
import { IsString, Length, Matches } from 'class-validator';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';

class GoogleLoginDto {
  @IsString() idToken!: string;
}

class PinDto {
  @IsString() @Matches(/^\d{6}$/) pin!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('google')
  async googleLogin(@Body() body: GoogleLoginDto) {
    return this.auth.loginWithGoogle(body.idToken);
  }

  @UseGuards(JwtAuthGuard)
  @Post('pin/set')
  async setPin(@CurrentUser('id') userId: string, @Body() body: PinDto) {
    await this.auth.setPin(userId, body.pin);
    return { ok: true };
  }

  @UseGuards(JwtAuthGuard)
  @Post('pin/verify')
  async verifyPin(@CurrentUser('id') userId: string, @Body() body: PinDto) {
    await this.auth.verifyPin(userId, body.pin);
    return { ok: true };
  }
}
