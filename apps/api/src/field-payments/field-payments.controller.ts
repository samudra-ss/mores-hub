import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { FieldPaymentsService } from './field-payments.service';
import { DisbursementService } from './disbursement.service';
import { ReconciliationService } from './reconciliation.service';
import { StorageService } from './storage.service';
import { verifyWebhookSignature } from './disbursement.provider';
import {
  CreateRequestDto,
  DecideDto,
  EnrollAgentDto,
  GatewayWebhookDto,
  TopupDto,
} from './dto';

@Controller('field-payments')
export class FieldPaymentsController {
  constructor(
    private readonly svc: FieldPaymentsService,
    private readonly disbursement: DisbursementService,
    private readonly reconciliation: ReconciliationService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  // ------------------------------------------------------------ agent

  @UseGuards(JwtAuthGuard)
  @Get('summary')
  summary(@CurrentUser('id') userId: string) {
    return this.svc.summary(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('requests/mine')
  mine(@CurrentUser('id') userId: string) {
    return this.svc.listMine(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('requests')
  @UseInterceptors(FileInterceptor('receipt')) // memory storage by default
  async create(
    @CurrentUser('id') userId: string,
    @Body() body: CreateRequestDto,
    @UploadedFile() receipt: Express.Multer.File,
  ) {
    const receiptKey = await this.storage.save(receipt);
    return this.svc.createRequest(userId, {
      kind: body.kind,
      amount: BigInt(body.amount),
      category: body.category,
      description: body.description,
      merchant: body.merchant,
      bankCode: body.bankCode,
      bankAccount: body.bankAccount,
      bankHolder: body.bankHolder,
      receiptKey,
    });
  }

  // ------------------------------------------------------------ finance

  @UseGuards(JwtAuthGuard)
  @Get('approvals')
  approvals(@CurrentUser('id') userId: string) {
    return this.svc.pendingQueue(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('approvals/:id')
  decide(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() body: DecideDto,
  ) {
    return this.svc.decide(userId, id, body.action, body.note);
  }

  @UseGuards(JwtAuthGuard)
  @Post('requests/:id/retry')
  async retry(@CurrentUser('id') userId: string, @Param('id') id: string) {
    await this.svc.requireFinance(userId);
    const gatewayRef = await this.disbursement.retry(id);
    return { ok: true, gatewayRef };
  }

  @UseGuards(JwtAuthGuard)
  @Post('agents')
  enroll(@CurrentUser('id') userId: string, @Body() body: EnrollAgentDto) {
    return this.svc.enrollAgent(userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('agents/:id/topup')
  topup(
    @CurrentUser('id') userId: string,
    @Param('id') agentId: string,
    @Body() body: TopupDto,
  ) {
    return this.svc.topup(userId, agentId, BigInt(body.amount), body.note);
  }

  @UseGuards(JwtAuthGuard)
  @Get('usage')
  usage(@CurrentUser('id') userId: string, @Query('month') month?: string) {
    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      throw new BadRequestException('month must be YYYY-MM');
    }
    return this.svc.usage(userId, month);
  }

  @UseGuards(JwtAuthGuard)
  @Get('reconciliation')
  async reconciliation(@CurrentUser('id') userId: string) {
    await this.svc.requireFinance(userId);
    return this.reconciliation.latest();
  }

  @UseGuards(JwtAuthGuard)
  @Post('reconciliation/run')
  async runReconciliation(@CurrentUser('id') userId: string) {
    await this.svc.requireFinance(userId);
    return this.reconciliation.run();
  }

  // ------------------------------------------------------------ receipts

  @UseGuards(JwtAuthGuard)
  @Get('receipts/:key')
  async receipt(
    @CurrentUser('id') userId: string,
    @Param('key') key: string,
    @Res() res: Response,
  ) {
    const req = await this.prisma.paymentRequest.findFirst({
      where: { receiptKey: key },
      include: { agent: true },
    });
    if (!req) throw new BadRequestException('Not found');
    const isOwner = req.agent.userId === userId;
    if (!isOwner) await this.svc.requireFinance(userId); // finance/admin may view all
    res.sendFile(this.storage.pathFor(key));
  }

  // ------------------------------------------------------------ webhook
  // Public endpoint, authenticated by HMAC signature over the raw body.
  // Requires NestFactory.create(AppModule, { rawBody: true }) in main.ts.

  @Post('webhooks/gateway')
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: GatewayWebhookDto,
  ) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(body));
    const signature = req.headers['x-callback-signature'] as string | undefined;
    if (!verifyWebhookSignature(raw, signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    return this.disbursement.settle(body.gatewayRef, body.status === 'settled');
  }
}
