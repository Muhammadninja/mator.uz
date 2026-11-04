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
import { AdminRefundsService } from './admin-refunds.service';
import {
  ListRefundsQueryDto,
  RecordRefundDto,
  VoidRefundDto,
} from './dto/record-refund.dto';

/**
 * The registry of money returned to customers. Every admin role can read it, so an
 * operator can answer a customer; writing it takes a manager, as confirming an
 * online payment by hand does.
 */
@ApiTags('Admin Refunds')
@ApiBearerAuth('jwt')
@Controller('v1/admin/refunds')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
export class AdminRefundsController {
  constructor(private readonly refunds: AdminRefundsService) {}

  private auditContext(
    req: Request & { user: AuthenticatedAdmin },
  ): AdminAuditContext {
    return {
      actor: { id: req.user.id, email: req.user.email, name: req.user.name },
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The refund registry, paged, with the total returned',
  })
  list(@Query() query: ListRefundsQueryDto) {
    return this.refunds.list(query);
  }

  @Get('orders/:orderId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "One order's refunds, and what it received and can still return",
  })
  forOrder(@Param('orderId') orderId: string) {
    return this.refunds.forOrder(orderId);
  }

  @Post('orders/:orderId')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Record money returned to a customer. Changes no order or payment status.',
  })
  record(
    @Param('orderId') orderId: string,
    @Body() dto: RecordRefundDto,
    @Req() req: Request & { user: AuthenticatedAdmin },
  ) {
    return this.refunds.record(orderId, dto, this.auditContext(req));
  }

  @Post(':id/void')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Take back a wrong entry, keeping it on record' })
  voidEntry(
    @Param('id') id: string,
    @Body() dto: VoidRefundDto,
    @Req() req: Request & { user: AuthenticatedAdmin },
  ) {
    return this.refunds.voidEntry(id, dto, this.auditContext(req));
  }
}
