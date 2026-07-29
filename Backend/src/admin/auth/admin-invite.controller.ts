import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminRole } from '@prisma/client';
import type { Request } from 'express';
import { AdminAuditContext } from './admin-auth.service';
import { AdminInviteService } from './admin-invite.service';
import { Roles } from './decorators/roles.decorator';
import {
  AcceptAdminInviteDto,
  AdminInvitePreviewDto,
  CreateAdminInviteDto,
} from './dto/admin-invite.dto';
import { AdminSessionResponseDto } from './dto/admin-session.response.dto';
import { AdminJwtGuard } from './guards/admin-jwt.guard';
import { AdminRoleGuard } from './guards/admin-role.guard';
import { AuthenticatedAdmin } from './strategies/admin-jwt.strategy';

type AuthenticatedAdminRequest = Request & { user: AuthenticatedAdmin };

/**
 * Invite-only admin signup, under /v1/auth/admin/invites.
 *
 *   • POST   /invites            SUPER_ADMIN issues an invite (email + role).
 *   • GET    /invites/:token     PUBLIC preview — the invited email + role.
 *   • POST   /invites/:token/accept  PUBLIC — set a password, get logged in.
 *
 * The raw token is never stored (only its SHA-256 hash) and never returned. All
 * three routes are throttled; the public two lean on the short expiry + single
 * use + hash-only storage so a leaked or guessed token is close to worthless.
 */
@ApiTags('Admin Auth')
@Controller('v1/auth/admin/invites')
export class AdminInviteController {
  constructor(private readonly invites: AdminInviteService) {}

  /** Actor + provenance for the audit entry of an invite. */
  private auditContext(req: AuthenticatedAdminRequest): AdminAuditContext {
    return {
      actor: { id: req.user.id, email: req.user.email, name: req.user.name },
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }

  @Post()
  @UseGuards(AdminJwtGuard, AdminRoleGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60 * 60 * 1000 } })
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Invite an administrator by email (SUPER_ADMIN)',
    description:
      'Issues a one-time, 48-hour invite link and emails it via Resend. Only the SHA-256 ' +
      'hash of the token is stored and NO token is ever returned in the response. Any ' +
      'pending invite for the same email is replaced. Recorded as INVITE_ADMIN.',
  })
  @ApiCreatedResponse({ description: 'Invite created and emailed.' })
  @ApiConflictResponse({
    description: 'An administrator with this email already exists.',
  })
  @ApiServiceUnavailableResponse({
    description: 'Email delivery is not configured (RESEND_API_KEY unset).',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid admin access token.',
  })
  @ApiForbiddenResponse({ description: 'Caller is not a SUPER_ADMIN.' })
  async create(
    @Body() dto: CreateAdminInviteDto,
    @Req() req: AuthenticatedAdminRequest,
  ): Promise<void> {
    await this.invites.createInvite(
      { email: dto.email, role: dto.role, inviter: this.auditContext(req).actor },
      this.auditContext(req),
    );
  }

  @Get(':token')
  @Throttle({ default: { limit: 20, ttl: 60 * 1000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview an invite (public)',
    description:
      'Returns only the invited email and role, so the accept page can show who the invite ' +
      'is for. A missing, expired or already-accepted token all return 404 identically, so ' +
      'the endpoint cannot be used to probe a token.',
  })
  @ApiOkResponse({ type: AdminInvitePreviewDto })
  @ApiNotFoundResponse({ description: 'Invite not found, expired or already used.' })
  preview(@Param('token') token: string): Promise<AdminInvitePreviewDto> {
    return this.invites.preview(token);
  }

  @Post(':token/accept')
  @Throttle({ default: { limit: 10, ttl: 60 * 1000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Accept an invite and create the account (public)',
    description:
      'The invitee sets a name + password. The email comes from the invite (already ' +
      'verified), the password is hashed with Argon2id, the invite is single-use, and a ' +
      'session is issued exactly as login does — so the panel can log the new admin ' +
      'straight in. Recorded as CREATE_ADMIN + ACCEPT_INVITE.',
  })
  @ApiCreatedResponse({ type: AdminSessionResponseDto })
  @ApiNotFoundResponse({ description: 'Invite not found, expired or already used.' })
  @ApiConflictResponse({
    description: 'An administrator with this email already exists.',
  })
  accept(
    @Param('token') token: string,
    @Body() dto: AcceptAdminInviteDto,
    @Req() req: Request,
  ): Promise<AdminSessionResponseDto> {
    return this.invites.accept(
      token,
      { name: dto.name, password: dto.password },
      { ip: req.ip, userAgent: req.get('user-agent') },
    );
  }
}
