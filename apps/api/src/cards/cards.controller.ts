import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsEnum, IsString } from 'class-validator';
import { CardBrand } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CardsService } from './cards.service';

class IssueCardDto {
  @IsString() walletId!: string;
  @IsEnum(CardBrand) brand!: CardBrand;
}

@UseGuards(JwtAuthGuard)
@Controller('cards')
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.cards.list(userId);
  }

  @Post()
  issue(@CurrentUser('id') userId: string, @Body() body: IssueCardDto) {
    return this.cards.issue({ userId, walletId: body.walletId, brand: body.brand });
  }
}
