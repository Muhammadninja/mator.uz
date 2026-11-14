import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import type { Request, Response } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AuthenticatedAdmin } from '../auth/strategies/admin-jwt.strategy';
import {
  AdminVehicleImagesService,
  MAX_UPLOAD_BYTES,
  type AdminContext,
} from './admin-vehicle-images.service';
import {
  ApproveCandidateDto,
  ReconcileDto,
  RejectCandidateDto,
  RevertReconcileDto,
} from './dto/admin-vehicle-images.dto';

type AdminRequest = Request & { user: AuthenticatedAdmin };

const context = (req: AdminRequest): AdminContext => ({
  actor: { id: req.user.id, email: req.user.email, name: req.user.name },
  ip: req.ip,
  userAgent: req.get('user-agent'),
});

/**
 * Garage vehicle image review. Every role reads; approving, rejecting,
 * uploading, retrying and re-resolving saved vehicles are manager decisions.
 */
@ApiTags('Admin Vehicle Images')
@ApiBearerAuth('jwt')
@Controller('v1/admin/vehicle-images')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
export class AdminVehicleImagesController {
  constructor(private readonly images: AdminVehicleImagesService) {}

  @Get('status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Coverage, pipeline health, registry handshake and what needs attention' })
  status() {
    return this.images.status();
  }

  @Get('queue')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Image subjects waiting for a person, most urgent first' })
  queue() {
    return this.images.queue();
  }

  @Get('requests/:id/history')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Jobs, candidates, publications and decisions of one image subject' })
  history(@Param('id') id: string) {
    return this.images.history(id);
  }

  @Get('candidates/:id/preview')
  @ApiOperation({ summary: 'The private candidate image (never public until approved)' })
  async preview(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const image = await this.images.preview(id);
    res.set({
      'content-type': image.contentType,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    return new StreamableFile(image.bytes);
  }

  @Post('candidates/:id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @ApiOperation({ summary: 'Publish a candidate (an unverified identity needs identityConfirmation)' })
  approve(@Param('id') id: string, @Body() dto: ApproveCandidateDto, @Req() req: AdminRequest) {
    return this.images.approve(id, dto, context(req));
  }

  @Post('candidates/:id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @ApiOperation({ summary: 'Reject a candidate; the same picture is never proposed again for it' })
  reject(@Param('id') id: string, @Body() dto: RejectCandidateDto, @Req() req: AdminRequest) {
    return this.images.reject(id, dto.reason, context(req));
  }

  @Post('requests/:id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @ApiOperation({ summary: 'Run acquisition again (free sources first; paid generation only where allowed)' })
  retry(@Param('id') id: string, @Req() req: AdminRequest) {
    return this.images.retry(id, context(req));
  }

  @Post('requests/:id/candidates')
  @HttpCode(HttpStatus.CREATED)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a transparent PNG/WebP as a private candidate (field "image", 8 MB)' })
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; size: number } | undefined,
    @Req() req: AdminRequest,
  ) {
    return this.images.upload(id, file, context(req));
  }

  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @ApiOperation({ summary: 'Re-resolve saved Garage vehicles (dry run unless apply=true)' })
  reconcile(@Body() dto: ReconcileDto, @Req() req: AdminRequest) {
    return this.images.reconcileRun(dto, context(req));
  }

  @Post('reconcile/revert')
  @HttpCode(HttpStatus.OK)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @ApiOperation({ summary: 'Undo one reconcile run (dry run unless apply=true)' })
  revert(@Body() dto: RevertReconcileDto, @Req() req: AdminRequest) {
    return this.images.revert(dto, context(req));
  }
}
