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
  Put,
  Query,
  Req,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import type { Request } from 'express';
import { MAX_PRODUCT_PHOTO_BYTES } from '../../common/image.constants';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AuthenticatedAdmin } from '../auth/strategies/admin-jwt.strategy';
import {
  AdminPartPhotosService,
  MAX_PART_PHOTOS,
  type PartPhotoFile,
  type PartPhotosContext,
} from './admin-part-photos.service';
import { AdminPhotoCoverageService } from './admin-photo-coverage.service';
import {
  ListPhotoCoverageQueryDto,
  ListPhotoRequestsQueryDto,
} from './dto/list-photo-coverage.query.dto';
import { PartPhotosVersionDto } from './dto/part-photos.dto';

type AdminRequest = Request & { user: AuthenticatedAdmin };

const context = (req: AdminRequest): PartPhotosContext => ({
  actor: { id: req.user.id, email: req.user.email, name: req.user.name },
  ip: req.ip,
  userAgent: req.get('user-agent'),
});

/**
 * Admin photo-coverage console ("Контроль фотографий"): the coverage numbers,
 * the parts behind them, and each part's photo editor (upload, replace one,
 * delete one, delete all). Admin-panel bearer token (AdminJwtGuard) + role
 * gate, the same roles as the inventory console it sits beside: a mobile
 * app-user token cannot reach it.
 */
@ApiTags('Admin Photo Coverage')
@ApiBearerAuth('jwt')
@Controller('v1/admin/photo-coverage')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
@ApiUnauthorizedResponse({
  description: 'Missing or invalid admin access token.',
})
@ApiForbiddenResponse({ description: 'Insufficient role for this operation.' })
export class AdminPhotoCoverageController {
  constructor(
    private readonly coverage: AdminPhotoCoverageService,
    private readonly photos: AdminPartPhotosService,
  ) {}

  @Get('summary')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Photo coverage totals and per-category breakdown',
    description:
      'Counts unique catalog parts. A part has a photo when the FIRST entry of ' +
      'catalog_parts.images is an absolute https URL (what the app card shows; ' +
      'it never falls back to a later photo). Categories are the live tree ' +
      '(category_id), each with its own and its subtree counts; empty ' +
      'categories are included.',
  })
  @ApiOkResponse({
    description: '{ totals, categories } in the admin envelope.',
  })
  summary() {
    return this.coverage.summary();
  }

  @Get('parts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Paginated parts with their photo state',
    description:
      'photo = all | with | without. categoryId includes its whole subtree. ' +
      "name, oem (OEM / GM number or id) and code1c (Driver's Village 1C code) " +
      'are case-insensitive contains searches.',
  })
  @ApiOkResponse({
    description: 'Paginated parts in the standard admin envelope.',
  })
  @ApiBadRequestResponse({ description: 'Invalid query parameter.' })
  list(@Query() query: ListPhotoCoverageQueryDto) {
    return this.coverage.list(query);
  }

  @Get('requests')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Parts customers asked a photo of, still waiting',
    description:
      'Open photo requests made through Mator AI, one row per part, most ' +
      'asked first. Each row has the part as the parts list shows it (null if ' +
      'it left the catalog). meta.pendingRequests counts the customers waiting.',
  })
  @ApiOkResponse({ description: 'Paginated parts in the standard admin envelope.' })
  @ApiBadRequestResponse({ description: 'Invalid query parameter.' })
  requests(@Query() query: ListPhotoRequestsQueryDto) {
    return this.coverage.requests(query);
  }

  // ── one part's photos ──────────────────────────────────────────────────────

  @Get('parts/:id/photos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "A part's photo gallery, as its editor shows it",
    description:
      'The ordered photos (the first is what the product card shows), the ' +
      'gallery version every change must send back, other catalog parts that ' +
      'share the gallery, and whether the buyer catalog already shows it.',
  })
  @ApiOkResponse({ description: 'The gallery in the admin envelope.' })
  @ApiNotFoundResponse({ description: 'PART_NOT_FOUND' })
  gallery(@Param('id') id: string) {
    return this.photos.gallery(id);
  }

  @Post('parts/:id/photos')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FilesInterceptor('photos', MAX_PART_PHOTOS, {
      limits: { fileSize: MAX_PRODUCT_PHOTO_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        photos: { type: 'array', items: { type: 'string', format: 'binary' } },
        version: { type: 'string' },
      },
      required: ['photos', 'version'],
    },
  })
  @ApiOperation({
    summary:
      'Upload new photos after the existing ones (JPEG, PNG, WebP; 10 MB each)',
  })
  @ApiOkResponse({ description: 'The new gallery.' })
  @ApiConflictResponse({ description: 'PHOTOS_CHANGED: reload the gallery.' })
  append(
    @Param('id') id: string,
    @Body() dto: PartPhotosVersionDto,
    @UploadedFiles() files: PartPhotoFile[] | undefined,
    @Req() req: AdminRequest,
  ) {
    return this.photos.append(id, dto.version, files, context(req));
  }

  @Put('parts/:id/photos/:index')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('photo', {
      limits: { fileSize: MAX_PRODUCT_PHOTO_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        photo: { type: 'string', format: 'binary' },
        version: { type: 'string' },
      },
      required: ['photo', 'version'],
    },
  })
  @ApiOperation({
    summary: 'Replace the photo at a position (0 = the main photo)',
  })
  @ApiOkResponse({ description: 'The new gallery.' })
  @ApiConflictResponse({ description: 'PHOTOS_CHANGED: reload the gallery.' })
  replace(
    @Param('id') id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: PartPhotosVersionDto,
    @UploadedFile() file: PartPhotoFile | undefined,
    @Req() req: AdminRequest,
  ) {
    return this.photos.replace(id, index, dto.version, file, context(req));
  }

  @Delete('parts/:id/photos/:index')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete the photo at a position; the ones after it move up',
    description: 'The Cloudinary asset is kept; only the link is removed.',
  })
  @ApiOkResponse({ description: 'The new gallery.' })
  @ApiConflictResponse({ description: 'PHOTOS_CHANGED: reload the gallery.' })
  remove(
    @Param('id') id: string,
    @Param('index', ParseIntPipe) index: number,
    @Query() dto: PartPhotosVersionDto,
    @Req() req: AdminRequest,
  ) {
    return this.photos.remove(id, index, dto.version, context(req));
  }

  @Delete('parts/:id/photos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete every photo of the part',
    description:
      'Buyer lists leave out a part without photos. The Cloudinary assets are kept.',
  })
  @ApiOkResponse({ description: 'The new (empty) gallery.' })
  @ApiConflictResponse({ description: 'PHOTOS_CHANGED: reload the gallery.' })
  clear(
    @Param('id') id: string,
    @Query() dto: PartPhotosVersionDto,
    @Req() req: AdminRequest,
  ) {
    return this.photos.clear(id, dto.version, context(req));
  }
}
