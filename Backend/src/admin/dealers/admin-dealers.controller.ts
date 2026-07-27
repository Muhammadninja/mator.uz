import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import type { Request } from 'express';
import { AdminAuditContext } from '../auth/admin-auth.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AuthenticatedAdmin } from '../auth/strategies/admin-jwt.strategy';
import { AdminDealersService } from './admin-dealers.service';
import { ListAdminDealersQueryDto } from './dto/list-admin-dealers.query.dto';
import {
  SuspendAdminDealerDto,
  UpdateAdminDealerDto,
} from './dto/update-admin-dealer.dto';

type AuthenticatedAdminRequest = Request & { user: AuthenticatedAdmin };

/**
 * Admin/operator dealer console. Admin-panel bearer token (AdminJwtGuard,
 * HS256) + role gate — a mobile app-user token cannot reach it at all. Every
 * admin role is an operator here: SUPER_ADMIN, MANAGER and OPERATOR all pass,
 * matching the orders console.
 *
 * Thin by construction: each route validates its input through a DTO and hands
 * off to AdminDealersService, which owns the state machine and writes the audit
 * entry in the same transaction as the change.
 */
@ApiTags('Admin Dealers')
@ApiBearerAuth('jwt')
@Controller('v1/admin/dealers')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
@ApiUnauthorizedResponse({
  description: 'Missing or invalid admin access token.',
})
@ApiForbiddenResponse({ description: 'Insufficient role for this operation.' })
export class AdminDealersController {
  constructor(private readonly dealers: AdminDealersService) {}

  /** Actor + provenance for the audit entry of a mutating call. */
  private auditContext(req: AuthenticatedAdminRequest): AdminAuditContext {
    return {
      actor: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
      },
      ip: req.ip,
      userAgent: req.get('user-agent'),
      // requestId is read from the ambient request context by the audit service.
    };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List dealers (admin/operator) — paginated, filterable, searchable',
    description:
      'Newest dealers first by default. `search` matches store name, city, email and ' +
      '(from four digits up) phone. `sort` accepts joinedAt, name, gmvUzs, orders or ' +
      'skus; anything else is rejected with 400. Money is an integer number of UZS.',
  })
  @ApiOkResponse({
    description: 'Paginated dealers in the standard admin envelope.',
  })
  list(@Query() query: ListAdminDealersQueryDto) {
    return this.dealers.list(query);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get one dealer (admin/operator)',
    description:
      'A superset of the list row: the same fields plus contact details, logo, rating, ' +
      'years in business and — while suspended — the suspension reason.',
  })
  @ApiOkResponse({ description: 'The dealer.' })
  @ApiNotFoundResponse({ description: 'No such dealer.' })
  getOne(@Param('id') id: string) {
    return this.dealers.getOne(id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update the editable dealer fields (admin/operator)',
    description:
      'Only `certified`, `lowestPrice` and `status` are editable; a body naming any ' +
      'other field is rejected with 400 rather than silently ignored. Each field that ' +
      'actually changes is audited with its own verb (certified enabled/disabled, ' +
      'lowest-price enabled/disabled, approved/suspended/reactivated). A status change ' +
      'goes through the same transition rules as the dedicated endpoints below.',
  })
  @ApiOkResponse({ description: 'The updated dealer.' })
  @ApiBadRequestResponse({
    description: 'Invalid field, invalid value, or illegal status transition.',
  })
  @ApiNotFoundResponse({ description: 'No such dealer.' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAdminDealerDto,
    @Req() req: AuthenticatedAdminRequest,
  ) {
    return this.dealers.update(id, dto, this.auditContext(req));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a pending dealer (admin/operator)',
    description:
      'pending → active. A dealer in any other state is rejected with 400. Recorded as ' +
      'DEALER_APPROVED with the previous and new status.',
  })
  @ApiOkResponse({ description: 'The updated dealer.' })
  @ApiBadRequestResponse({ description: 'The dealer is not pending.' })
  @ApiNotFoundResponse({ description: 'No such dealer.' })
  approve(@Param('id') id: string, @Req() req: AuthenticatedAdminRequest) {
    return this.dealers.approve(id, this.auditContext(req));
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspend an active dealer (admin/operator)',
    description:
      'active → suspended. The optional reason is persisted on the dealer and stored on ' +
      'the DEALER_SUSPENDED audit entry.',
  })
  @ApiOkResponse({ description: 'The updated dealer.' })
  @ApiBadRequestResponse({ description: 'The dealer is not active.' })
  @ApiNotFoundResponse({ description: 'No such dealer.' })
  suspend(
    @Param('id') id: string,
    @Body() dto: SuspendAdminDealerDto,
    @Req() req: AuthenticatedAdminRequest,
  ) {
    return this.dealers.suspend(id, this.auditContext(req), dto.reason);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reactivate a suspended dealer (admin/operator)',
    description:
      'suspended → active. Clears the suspension reason so it never trails an active ' +
      'dealer. Recorded as DEALER_REACTIVATED.',
  })
  @ApiOkResponse({ description: 'The updated dealer.' })
  @ApiBadRequestResponse({ description: 'The dealer is not suspended.' })
  @ApiNotFoundResponse({ description: 'No such dealer.' })
  reactivate(@Param('id') id: string, @Req() req: AuthenticatedAdminRequest) {
    return this.dealers.reactivate(id, this.auditContext(req));
  }
}
