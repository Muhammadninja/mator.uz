import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import type { Request } from 'express';
import { AdminAuditContext } from '../auth/admin-auth.service';
import { AdminAuditService } from '../auth/admin-audit.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AuthenticatedAdmin } from '../auth/strategies/admin-jwt.strategy';
import { AdminManagementService } from './admin-management.service';
import {
  AdminResponseDto,
  ChangeAdminPasswordDto,
  ChangeAdminRoleDto,
  CreateAdminDto,
  ListAdminsQueryDto,
  ListAuditQueryDto,
  UpdateAdminDto,
} from './dto/admin-management.dto';

type AuthenticatedAdminRequest = Request & { user: AuthenticatedAdmin };

/**
 * Administrator management console (/v1/admins).
 *
 * Authorization: every route requires a valid ADMIN token (AdminJwtGuard) — a
 * mobile user token cannot reach any of it. Reads are open to SUPER_ADMIN and
 * MANAGER; every MUTATION and the audit trail are SUPER_ADMIN only, so the
 * ability to grant privileges never leaks to a lower role.
 *
 * Nothing here re-implements security logic: each mutation delegates to
 * AdminAuthService, which writes the audit entry in the same transaction and
 * revokes sessions where required. The correlation id of the calling request is
 * picked up automatically and stored on the audit row.
 */
@ApiTags('Admin Management')
@ApiBearerAuth('jwt')
@Controller('v1/admins')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@ApiUnauthorizedResponse({
  description: 'Missing or invalid admin access token.',
})
@ApiForbiddenResponse({ description: 'Insufficient role for this operation.' })
export class AdminManagementController {
  constructor(
    private readonly admins: AdminManagementService,
    private readonly audit: AdminAuditService,
  ) {}

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

  // ── Audit ─────────────────────────────────────────────────────────────────
  // Declared BEFORE the ':id' routes: Express matches top-down, so a literal
  // path registered after a parameterized one would be swallowed by it
  // ("audit" would arrive as :id).
  @Get('audit')
  @Roles(AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Administrator audit trail (SUPER_ADMIN)',
    description:
      'Append-only record of critical actions: creation, role changes, password changes, ' +
      'activation/deactivation and deletion. Each entry snapshots the actor and target ' +
      'identities, and carries the requestId of the originating HTTP request — grep the ' +
      'server log for it to see the whole incident. Never contains credentials.',
  })
  @ApiOkResponse({ description: 'Paginated audit entries, newest first.' })
  listAudit(@Query() query: ListAuditQueryDto) {
    return this.audit.list(query);
  }

  // ── Administrators ────────────────────────────────────────────────────────
  @Get()
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List administrators',
    description:
      'Paginated, filterable by role and activation state, searchable by name or email. ' +
      'Password hashes are never returned.',
  })
  @ApiOkResponse({ description: 'Paginated administrators.' })
  list(@Query() query: ListAdminsQueryDto) {
    return this.admins.list(query);
  }

  @Post()
  @Roles(AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an administrator (SUPER_ADMIN)',
    description:
      'There is no public registration. The password is hashed with Argon2id and never ' +
      'stored or returned in plaintext. Recorded as CREATE_ADMIN in the audit trail.',
  })
  @ApiCreatedResponse({ type: AdminResponseDto })
  @ApiConflictResponse({ description: 'That email is already registered.' })
  create(@Body() dto: CreateAdminDto, @Req() req: AuthenticatedAdminRequest) {
    return this.admins.create(dto, this.auditContext(req));
  }

  @Get(':id')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get one administrator' })
  @ApiOkResponse({ type: AdminResponseDto })
  @ApiNotFoundResponse({ description: 'No such administrator.' })
  getOne(@Param('id') id: string) {
    return this.admins.getOne(id);
  }

  @Patch(':id')
  @Roles(AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update an administrator profile (SUPER_ADMIN)',
    description:
      'Name and email only. Role, password and activation each have their own dedicated ' +
      'endpoint — they are security events, and folding them into a generic PATCH would ' +
      'make it too easy to grant privileges by accident.',
  })
  @ApiOkResponse({ type: AdminResponseDto })
  @ApiConflictResponse({ description: 'That email is already registered.' })
  @ApiNotFoundResponse({ description: 'No such administrator.' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAdminDto,
    @Req() req: AuthenticatedAdminRequest,
  ) {
    return this.admins.update(id, dto, this.auditContext(req));
  }

  @Patch(':id/role')
  @Roles(AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change an administrator role (SUPER_ADMIN)',
    description:
      'Recorded as CHANGE_ROLE with the previous and new role. Every session of that ' +
      'administrator is revoked, so the new privileges apply from a fresh login rather ' +
      'than being carried by a token minted under the old role. Refuses to demote you ' +
      'or the last active SUPER_ADMIN.',
  })
  @ApiOkResponse({ type: AdminResponseDto })
  changeRole(
    @Param('id') id: string,
    @Body() dto: ChangeAdminRoleDto,
    @Req() req: AuthenticatedAdminRequest,
  ) {
    return this.admins.changeRole(id, dto.role, this.auditContext(req));
  }

  @Patch(':id/password')
  @Roles(AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Reset an administrator's password (SUPER_ADMIN)",
    description:
      'Hashed with Argon2id. Every session of that administrator is revoked. Recorded as ' +
      'RESET_PASSWORD (or CHANGE_PASSWORD when changing your own) — the audit stores only ' +
      'that it happened, never any part of the credential.',
  })
  @ApiNoContentResponse({ description: 'Password changed; sessions revoked.' })
  async changePassword(
    @Param('id') id: string,
    @Body() dto: ChangeAdminPasswordDto,
    @Req() req: AuthenticatedAdminRequest,
  ): Promise<void> {
    await this.admins.changePassword(id, dto.password, this.auditContext(req));
  }

  @Patch(':id/activate')
  @Roles(AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reactivate an administrator (SUPER_ADMIN)',
    description: 'Idempotent. Recorded as REACTIVATE_ADMIN.',
  })
  @ApiOkResponse({ type: AdminResponseDto })
  activate(@Param('id') id: string, @Req() req: AuthenticatedAdminRequest) {
    return this.admins.activate(id, this.auditContext(req));
  }

  @Patch(':id/deactivate')
  @Roles(AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate an administrator (SUPER_ADMIN)',
    description:
      'Takes effect immediately: the account is re-read on every authenticated request, so ' +
      'a live access token stops working on its next use rather than at the end of its TTL. ' +
      'All sessions are revoked. Refuses to deactivate you or the last active SUPER_ADMIN.',
  })
  @ApiOkResponse({ type: AdminResponseDto })
  deactivate(@Param('id') id: string, @Req() req: AuthenticatedAdminRequest) {
    return this.admins.deactivate(id, this.auditContext(req));
  }

  @Delete(':id')
  @Roles(AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an administrator (SUPER_ADMIN)',
    description:
      'The DELETE_ADMIN audit entry is written before the row is removed and survives it, ' +
      'so the deletion stays on record. Refuses to delete you or the last active SUPER_ADMIN.',
  })
  @ApiNoContentResponse({ description: 'Administrator deleted.' })
  async remove(
    @Param('id') id: string,
    @Req() req: AuthenticatedAdminRequest,
  ): Promise<void> {
    await this.admins.remove(id, this.auditContext(req));
  }

  // ── Sessions of another administrator ─────────────────────────────────────
  // Distinct from /v1/auth/admin/sessions, which is always the CALLER's own.
  @Get(':id/sessions')
  @Roles(AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "List another administrator's active sessions (SUPER_ADMIN)",
    description:
      'One entry per signed-in device. Refresh tokens are never returned — only a hash is ' +
      'stored. For your own sessions use GET /v1/auth/admin/sessions.',
  })
  @ApiOkResponse({ description: 'Active sessions, most recently used first.' })
  listSessions(@Param('id') id: string) {
    return this.admins.listSessions(id);
  }

  @Delete(':id/sessions/:sessionId')
  @Roles(AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "End one of another administrator's sessions (SUPER_ADMIN)",
    description:
      'Signs that one device out, leaving their other sessions alone. To end every session ' +
      'at once, deactivate the account or change its password.',
  })
  @ApiNoContentResponse({ description: 'Session revoked.' })
  @ApiNotFoundResponse({
    description: 'No such live session for that administrator.',
  })
  async revokeSession(
    @Param('id') id: string,
    @Param('sessionId', ParseIntPipe) sessionId: number,
  ): Promise<void> {
    await this.admins.revokeSession(id, sessionId);
  }
}
