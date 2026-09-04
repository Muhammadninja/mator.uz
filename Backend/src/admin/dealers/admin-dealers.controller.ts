import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import type { Request } from 'express';
import { MAX_AVATAR_BYTES } from '../../common/image.constants';
import { AdminAuditContext } from '../auth/admin-auth.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AuthenticatedAdmin } from '../auth/strategies/admin-jwt.strategy';
import { AdminDealersService } from './admin-dealers.service';
import { CreateAdminDealerDto } from './dto/create-admin-dealer.dto';
import { ListAdminDealersQueryDto } from './dto/list-admin-dealers.query.dto';
import {
  SuspendAdminDealerDto,
  UpdateAdminDealerDto,
} from './dto/update-admin-dealer.dto';

// Multipart field names accepted for the logo image, in priority order —
// mirrors the avatar endpoint so a variety of clients work unchanged.
const LOGO_FIELD_PRIORITY = ['logo', 'file', 'image'] as const;

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

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a curated dealer/storefront (admin/operator)',
    description:
      'Only `name` is required. A dealer created here is a real, vetted storefront: ' +
      'unless the body overrides it, it lands ACTIVE + certified and marked curated, ' +
      'so it appears in the app’s MATOR Certified rail (GET /v1/dealers) immediately. ' +
      'Upload the brand logo via POST /v1/admin/dealers/logo first and pass the ' +
      'returned URL as `logoUrl`. Recorded as DEALER_CREATED.',
  })
  @ApiCreatedResponse({ description: 'The created dealer.' })
  @ApiBadRequestResponse({ description: 'Invalid field or value.' })
  create(
    @Body() dto: CreateAdminDealerDto,
    @Req() req: AuthenticatedAdminRequest,
  ) {
    return this.dealers.create(dto, this.auditContext(req));
  }

  @Post('logo')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    AnyFilesInterceptor({ limits: { fileSize: MAX_AVATAR_BYTES, files: 1 } }),
  )
  @ApiOperation({
    summary: 'Upload a dealer brand logo (multipart/form-data)',
    description:
      'Field: `logo` (aliases `file`, `image`). Image ≤ 5 MB (JPEG/PNG/WebP). ' +
      'Stored on the shared Cloudinary image host and returned as `logoUrl` — pass ' +
      'that back on create or PATCH. Delivered as PNG so the mobile app can render it.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        logo: {
          type: 'string',
          format: 'binary',
          description:
            'Image file (JPEG/PNG/WebP, ≤ 5 MB). Aliases: `file`, `image`.',
        },
      },
      required: ['logo'],
    },
  })
  @ApiOkResponse({
    description: 'Uploaded. Returns the stored image URL as `logoUrl`.',
  })
  uploadLogo(
    @UploadedFiles()
    files?: Array<{
      fieldname: string;
      buffer: Buffer;
      mimetype: string;
      size: number;
    }>,
  ) {
    const file =
      LOGO_FIELD_PRIORITY.map((name) =>
        files?.find((f) => f.fieldname === name),
      ).find(Boolean) ?? files?.[0];
    return this.dealers.uploadLogo(file);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'List dealers (admin/operator) — paginated, filterable, searchable',
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

  /**
   * Issue the dealer's 1C integration credential.
   *
   * Narrower than the rest of this controller: a key grants the ability to
   * rewrite a dealer's stock and prices, so issuing one is not routine operator
   * work. The method-level @Roles TIGHTENS the class-level list rather than
   * replacing it — Nest guards are additive, and AdminRoleGuard reads the
   * closest decorator via getAllAndOverride.
   */
  @Post(':id/api-key')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Issue a 1C integration API key for the dealer (admin/manager)',
    description:
      'Generates the dealer credential for POST /v1/integrations/dealers/sync-inventory. ' +
      'The plaintext key is returned ONCE in this response and never again — only its ' +
      'SHA-256 digest is stored, so it cannot be recovered, only replaced. Calling this ' +
      'on a dealer that already has a key ROTATES it: the previous key stops working ' +
      'immediately. Recorded as DEALER_API_KEY_ISSUED (suffix and timestamps only).',
  })
  @ApiCreatedResponse({
    description: 'The newly issued key — shown once.',
    schema: {
      example: {
        success: true,
        data: {
          dealerId: 'd1',
          apiKey: 'mtr_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          apiKeyLast4: '8f2c',
          issuedAt: '2026-09-04T20:30:00.000Z',
        },
        message:
          'Store this key now — it is shown once and cannot be retrieved again.',
      },
    },
  })
  @ApiNotFoundResponse({ description: 'No such dealer.' })
  issueApiKey(@Param('id') id: string, @Req() req: AuthenticatedAdminRequest) {
    return this.dealers.issueApiKey(id, this.auditContext(req));
  }

  /** Revoke the dealer's integration credential. Same narrowed role list. */
  @Delete(':id/api-key')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke the dealer’s 1C integration API key (admin/manager)',
    description:
      'Clears the stored digest, so the dealer’s next sync attempt is rejected with 401. ' +
      'Idempotent — revoking a dealer that has no key succeeds and changes nothing. ' +
      'Recorded as DEALER_API_KEY_REVOKED.',
  })
  @ApiOkResponse({
    schema: {
      example: { success: true, data: { dealerId: 'd1', revoked: true } },
    },
  })
  @ApiNotFoundResponse({ description: 'No such dealer.' })
  revokeApiKey(@Param('id') id: string, @Req() req: AuthenticatedAdminRequest) {
    return this.dealers.revokeApiKey(id, this.auditContext(req));
  }
}
