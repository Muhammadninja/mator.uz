import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminRole } from '@prisma/client';
import type { Request } from 'express';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AdminRefreshDto } from './dto/admin-refresh.dto';
import {
  AdminProfileResponseDto,
  AdminSessionResponseDto,
  AdminSessionSummaryDto,
} from './dto/admin-session.response.dto';
import { ListAdminAuditQueryDto } from './dto/list-admin-audit.query.dto';
import { Roles } from './decorators/roles.decorator';
import { AdminJwtGuard } from './guards/admin-jwt.guard';
import { AdminRoleGuard } from './guards/admin-role.guard';
import { AuthenticatedAdmin } from './strategies/admin-jwt.strategy';

/** A request that has passed AdminJwtGuard, so `user` is always present. */
type AuthenticatedAdminRequest = Request & { user: AuthenticatedAdmin };

/**
 * Admin-panel authentication under /v1/auth/admin. Entirely separate from the
 * mobile app's /v1/auth OTP flow: email + password only, its own JWT secret, and
 * its own guard — a mobile user token is rejected by every route here.
 *
 * There is intentionally NO registration route. The first SUPER_ADMIN is created
 * by the CLI bootstrap script (`npm run admin:create`); further administrators
 * are created by a SUPER_ADMIN.
 */
@ApiTags('Admin Auth')
@Controller('v1/auth/admin')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @Post('login')
  // Tighter than the global baseline: this is the one endpoint where an
  // attacker can guess passwords.
  @Throttle({ default: { limit: 5, ttl: 60 * 1000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin login (email + password)',
    description:
      'Authenticates an administrator and opens a session. An unknown email and a wrong ' +
      'password are reported identically, so admin emails cannot be enumerated. A ' +
      'deactivated account (isActive = false) is refused.',
  })
  @ApiOkResponse({ type: AdminSessionResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Invalid email or password, or account deactivated.',
  })
  login(@Body() dto: AdminLoginDto, @Req() req: Request) {
    // Session provenance for the "active sessions" list. `req.ip` is the real
    // client address because main.ts sets `trust proxy` for the Nginx hop. All
    // three values are untrusted and display-only.
    return this.adminAuth.login(dto, {
      deviceName: dto.deviceName,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  }

  @Post('refresh')
  @Throttle({ default: { limit: 20, ttl: 60 * 1000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate an admin refresh token',
    description:
      'Exchanges a refresh token for a NEW access + refresh pair. The presented token is ' +
      'invalidated by the exchange. Presenting an already-used token is treated as theft: ' +
      'every session of that administrator is revoked immediately.',
  })
  @ApiOkResponse({ type: AdminSessionResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Refresh token invalid, expired, revoked, or reused.',
  })
  refresh(@Body() dto: AdminRefreshDto) {
    return this.adminAuth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Admin logout',
    description:
      'Invalidates the supplied refresh token, so it can no longer be rotated. Other ' +
      'sessions belonging to this administrator are unaffected.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid admin access token.',
  })
  async logout(@Body() dto: AdminRefreshDto): Promise<void> {
    await this.adminAuth.logout(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Current administrator',
    description:
      'Returns the authenticated administrator. Never includes passwordHash, refresh tokens, ' +
      'or any other sensitive field.',
  })
  @ApiOkResponse({ type: AdminProfileResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid admin access token.',
  })
  me(@Req() req: AuthenticatedAdminRequest) {
    return this.adminAuth.me(req.user);
  }

  @Get('sessions')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "List the current administrator's active sessions",
    description:
      'One entry per signed-in device. Logging in from a second device does NOT end the ' +
      'first — sessions are independent. Device name, IP and user agent are client-supplied ' +
      'and shown for recognition only. Refresh tokens themselves are never returned.',
  })
  @ApiOkResponse({ type: [AdminSessionSummaryDto] })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid admin access token.',
  })
  sessions(@Req() req: AuthenticatedAdminRequest) {
    return this.adminAuth.listSessions(req.user.id);
  }

  @Delete('sessions/:id')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'End one session ("sign out this device")',
    description:
      'Revokes a single session by id, leaving every other device signed in. Only the ' +
      "caller's own sessions can be ended; an id belonging to another administrator is " +
      'reported as not found.',
  })
  @ApiNoContentResponse({ description: 'Session revoked.' })
  @ApiNotFoundResponse({
    description: 'No such live session for this administrator.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid admin access token.',
  })
  async revokeSession(
    @Req() req: AuthenticatedAdminRequest,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    await this.adminAuth.revokeSession(req.user.id, id);
  }

  @Get('audit')
  @UseGuards(AdminJwtGuard, AdminRoleGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Read the administrator audit trail (SUPER_ADMIN only)',
    description:
      'Append-only record of critical actions on administrator accounts: creation, role ' +
      'changes, activation/deactivation, password changes and deletion. Actor and target ' +
      'identities are snapshots taken at write time, so entries stay readable after an ' +
      'account is renamed or deleted. Never contains passwords, hashes or tokens. ' +
      'Restricted to SUPER_ADMIN: the log reveals the shape of the administrator team.',
  })
  @ApiOkResponse({ description: 'Paginated audit entries, newest first.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid admin access token.',
  })
  @ApiForbiddenResponse({ description: 'Caller is not a SUPER_ADMIN.' })
  audit(@Query() query: ListAdminAuditQueryDto) {
    return this.adminAuth.listAudit(query);
  }
}
