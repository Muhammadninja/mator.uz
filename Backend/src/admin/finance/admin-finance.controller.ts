import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import type { Request } from 'express';
import { AdminAuditContext } from '../auth/admin-auth.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AuthenticatedAdmin } from '../auth/strategies/admin-jwt.strategy';
import { AdminFinanceChecksService } from './admin-finance-checks.service';
import { AdminFinanceService } from './admin-finance.service';
import {
  FiscalIssuesQueryDto,
  PayoutHoldDto,
  RecordPayoutDto,
  StatementQueryDto,
  VoidPayoutDto,
} from './dto/payout.dto';

/**
 * The money side: what sellers are owed and were paid, what Mator keeps, each order's money
 * by whose it is, and payments whose fiscal receipts need a look. Every admin role can read
 * it, like the refund registry; recording or voiding a payout and holding an order back take a
 * manager. A payout here records money already sent outside the system: none is sent from it.
 */
@ApiTags('Admin Finance')
@ApiBearerAuth('jwt')
@Controller('v1/admin/finance')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
export class AdminFinanceController {
  constructor(
    private readonly finance: AdminFinanceService,
    private readonly checks: AdminFinanceChecksService,
  ) {}

  private auditContext(
    req: Request & { user: AuthenticatedAdmin },
  ): AdminAuditContext {
    return {
      actor: { id: req.user.id, email: req.user.email, name: req.user.name },
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }

  @Get('sellers')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'What each seller is owed and was paid, and what Mator keeps (service fee, delivery)',
  })
  sellers() {
    return this.finance.sellers();
  }

  @Get('sellers/:sellerId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "One seller's balance, orders and payouts" })
  seller(@Param('sellerId') sellerId: string) {
    return this.finance.seller(sellerId);
  }

  @Post('sellers/:sellerId/payouts')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Record money already sent to a seller outside the system (it sends nothing). At most what is payable now on delivered orders.',
  })
  recordPayout(
    @Param('sellerId') sellerId: string,
    @Body() dto: RecordPayoutDto,
    @Req() req: Request & { user: AuthenticatedAdmin },
  ) {
    return this.finance.recordPayout(sellerId, dto, this.auditContext(req));
  }

  @Post('payouts/:id/void')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take back a wrong payout entry, keeping it on record',
  })
  voidPayout(
    @Param('id') id: string,
    @Body() dto: VoidPayoutDto,
    @Req() req: Request & { user: AuthenticatedAdmin },
  ) {
    return this.finance.voidPayout(id, dto, this.auditContext(req));
  }

  @Get('orders/:orderId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "One order's money by whose it is, with its payments and fiscal receipts",
  })
  order(@Param('orderId') orderId: string) {
    return this.checks.order(orderId);
  }

  @Post('orders/:orderId/payout-hold')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Hold an order back from seller payouts while a cancellation or return is under way',
  })
  holdPayout(
    @Param('orderId') orderId: string,
    @Body() dto: PayoutHoldDto,
    @Req() req: Request & { user: AuthenticatedAdmin },
  ) {
    return this.finance.setPayoutHold(
      orderId,
      true,
      dto,
      this.auditContext(req),
    );
  }

  @Post('orders/:orderId/payout-hold/release')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Release an order for seller payouts again' })
  releasePayout(
    @Param('orderId') orderId: string,
    @Body() dto: PayoutHoldDto,
    @Req() req: Request & { user: AuthenticatedAdmin },
  ) {
    return this.finance.setPayoutHold(
      orderId,
      false,
      dto,
      this.auditContext(req),
    );
  }

  @Get('payme-statement')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Payme's GetStatement for a window, each transaction checked against the refund registry",
  })
  paymeStatement(@Query() query: StatementQueryDto) {
    return this.checks.paymeStatement(query);
  }

  @Get('fiscal-issues')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Payme payments with a missing, refused or contradicted receipt; refunds outside Payme with no return receipt, or one only an operator stated; Payme refunds Payme has not confirmed',
  })
  fiscalIssues(@Query() query: FiscalIssuesQueryDto) {
    return this.checks.fiscalIssues(query);
  }
}
