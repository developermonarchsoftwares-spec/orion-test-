import { Controller, Get, Post, Body, Param, Query, Res, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { BillingService } from './billing.service';
import { PaymentService } from './payment.service';
import { RefundPaymentDto } from './dto/payment.dto';
import { CurrentUser, Roles } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { IJwtPayload, UserRole } from '@orion/shared';
import { htmlPageCsp } from '../../common/http/security-headers';

@ApiTags('Billing')
@ApiBearerAuth()
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly payments: PaymentService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('subscription')
  @ApiOperation({ summary: 'Current plan / tier, status and expiry' })
  subscription(@CurrentUser() user: IJwtPayload) {
    return this.billing.getSubscription(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get('topup/quote')
  @ApiOperation({ summary: 'Server-side price for a top-up of N credits, and the allowed range' })
  topUpQuote(@Query('credits') credits: string) {
    return this.billing.quoteTopUp(Number(credits));
  }

  @UseGuards(JwtAuthGuard)
  @Get('history')
  @ApiOperation({ summary: 'Billing history: purchases, top-ups, refunds and adjustments' })
  history(@CurrentUser() user: IJwtPayload, @Query('page') page = '1', @Query('limit') limit = '20') {
    return this.billing.history(user.sub, Number(page), Number(limit));
  }

  @UseGuards(JwtAuthGuard)
  @Get('invoices')
  @ApiOperation({ summary: 'List invoices' })
  invoices(@CurrentUser() user: IJwtPayload) {
    return this.billing.listInvoices(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get('invoices/:id')
  @ApiOperation({ summary: 'One invoice (JSON), with the seller details the PDF needs' })
  async invoice(@CurrentUser() user: IJwtPayload, @Param('id') id: string) {
    const inv = await this.billing.getInvoice(user.sub, id);
    return { ...inv, seller: this.billing.sellerDetails() };
  }

  @UseGuards(JwtAuthGuard)
  @Get('invoices/:id/html')
  @ApiOperation({ summary: 'Printable invoice (HTML; use the browser to save as PDF)' })
  async invoiceHtml(@CurrentUser() user: IJwtPayload, @Param('id') id: string, @Res() res: Response) {
    const inv = await this.billing.getInvoice(user.sub, id);
    const html = this.billing.renderInvoiceHtml(inv);
    res.setHeader('Content-Security-Policy', htmlPageCsp(html)); // no script at all, no external resource
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('html').send(html);
  }

  // ---- admin ----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN) // refunds move money: super administrator only (listing refunds stays open to ADMIN)
  @Post('admin/refunds')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: refund a credited payment in full (reverses credits, marks the invoice, records the refund)' })
  refund(@CurrentUser() admin: IJwtPayload, @Body() dto: RefundPaymentDto) {
    return this.payments.refundPayment(admin.sub, dto.paymentId, dto.reason);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @Get('admin/refunds')
  @ApiOperation({ summary: 'Admin: list refunds' })
  refunds() {
    return this.payments.listRefunds();
  }
}
