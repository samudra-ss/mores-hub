import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '@prisma/client';

@Controller('me')
@UseGuards(JwtAuthGuard)
export class UsersController {
  @Get()
  me(@CurrentUser() user: User) {
    const { pinHash, ...safe } = user;
    return { ...safe, hasPin: !!pinHash };
  }
}
