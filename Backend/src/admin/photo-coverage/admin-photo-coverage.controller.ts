import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AdminPhotoCoverageService } from './admin-photo-coverage.service';
import { ListPhotoCoverageQueryDto } from './dto/list-photo-coverage.query.dto';

/**
 * Admin photo-coverage console ("Контроль фотографий"). Read-only. Admin-panel
 * bearer token (AdminJwtGuard) + role gate, the same roles as the inventory
 * console it sits beside: a mobile app-user token cannot reach it.
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
  constructor(private readonly coverage: AdminPhotoCoverageService) {}

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
}
