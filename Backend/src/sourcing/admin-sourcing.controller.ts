import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { Roles } from '../admin/auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../admin/auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../admin/auth/guards/admin-role.guard';
import { AuthenticatedAdmin } from '../admin/auth/strategies/admin-jwt.strategy';
import { SourcingService } from './sourcing.service';
import { ClassifySourcingOfferDto } from './dto/classify-sourcing-offer.dto';
import { QuerySourcingTicketsDto } from './dto/query-sourcing-tickets.dto';
import { UpdateTicketStatusDto } from './dto/update-ticket-status.dto';

/**
 * Operator console for AI part-sourcing tickets. Admin-panel bearer token
 * (AdminJwtGuard, HS256) + role gate — a mobile app-user token cannot reach it.
 * SUPER_ADMIN, MANAGER and OPERATOR all pass, matching the other admin consoles.
 * Thin: each route validates through a DTO and hands off to SourcingService.
 */
@ApiTags('Admin Sourcing')
@ApiBearerAuth('jwt')
@Controller('v1/admin/sourcing-tickets')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid admin access token.' })
@ApiForbiddenResponse({ description: 'Insufficient role for this operation.' })
export class AdminSourcingController {
  constructor(private readonly sourcing: SourcingService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List sourcing tickets (paginated, newest first)',
    description:
      'Optional status filter. Returns the standard admin envelope: ' +
      '{ success, data, meta: { total, page, limit, totalPages } }.',
  })
  @ApiOkResponse({ description: 'Matching tickets in the standard admin envelope.' })
  @ApiBadRequestResponse({ description: 'Invalid query parameter.' })
  list(@Query() query: QuerySourcingTicketsDto) {
    return this.sourcing.findAllForAdmin(query);
  }

  @Patch('offers/:offerId/classification')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Say what a sourcing offer is, so it can be paid for online',
    description:
      'A seller’s offer has no category, so it has no MXIK, and Payme checkout ' +
      'refuses it until an operator sets one here. The reply lists anything the ' +
      'receipt would still lack. Replaces the classification as a whole.',
  })
  @ApiOkResponse({ description: 'The classification and what is still missing.' })
  @ApiNotFoundResponse({ description: 'No such offer or category.' })
  @ApiBadRequestResponse({ description: 'Invalid body.' })
  classifyOffer(
    @Param('offerId') offerId: string,
    @Body() dto: ClassifySourcingOfferDto,
    @Req() req: Request & { user: AuthenticatedAdmin },
  ) {
    return this.sourcing.classifyOffer(offerId, dto, {
      actor: { id: req.user.id, email: req.user.email, name: req.user.name },
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  }

  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update ticket status',
    description: 'Moves a ticket through PENDING -> IN_PROGRESS -> OFFERED -> CLOSED.',
  })
  @ApiOkResponse({ description: 'The updated ticket.' })
  @ApiNotFoundResponse({ description: 'No ticket with that id.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid status.' })
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTicketStatusDto,
  ) {
    const ticket = await this.sourcing.updateStatus(id, dto.status);
    return { success: true, data: ticket };
  }

  @Delete(':id')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a sourcing ticket (manager or super admin)',
    description: 'Permanently removes the ticket. Idempotent envelope: { success }.',
  })
  @ApiOkResponse({ description: 'The ticket was deleted.' })
  @ApiNotFoundResponse({ description: 'No ticket with that id.' })
  @ApiBadRequestResponse({ description: 'Malformed id.' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.sourcing.deleteTicket(id);
    return { success: true };
  }
}
