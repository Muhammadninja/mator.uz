import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
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
import { Roles } from '../admin/auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../admin/auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../admin/auth/guards/admin-role.guard';
import { SourcingService } from './sourcing.service';
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
}
