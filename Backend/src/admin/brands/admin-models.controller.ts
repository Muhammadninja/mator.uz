import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AdminBrandsService } from './admin-brands.service';
import { UpdateAdminModelDto } from './dto/update-admin-model.dto';

/**
 * Admin/operator vehicle-models console — the update/delete half of the
 * brands+models CRUD. Creation lives under the brand (POST
 * /v1/admin/brands/:brandId/models); a model is edited and deleted by its own
 * id here because Nest needs a distinct base path from AdminBrandsController.
 * Shares AdminBrandsService, so cache invalidation stays in one place.
 */
@ApiTags('Admin Brands')
@ApiBearerAuth('jwt')
@Controller('v1/admin/models')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid admin access token.' })
@ApiForbiddenResponse({ description: 'Insufficient role for this operation.' })
export class AdminModelsController {
  constructor(private readonly brands: AdminBrandsService) {}

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update a model (admin/operator)',
    description:
      'Editable: name, yearFrom, yearTo, bodyType. Busts the parent brand’s ' +
      'models cache so the change appears in the app immediately.',
  })
  @ApiOkResponse({ description: 'The updated model.' })
  @ApiBadRequestResponse({ description: 'Invalid field or value.' })
  @ApiNotFoundResponse({ description: 'No such model.' })
  @ApiConflictResponse({ description: 'A model with this name already exists.' })
  update(@Param('id') id: string, @Body() dto: UpdateAdminModelDto) {
    return this.brands.updateModel(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a model (admin/operator)',
    description:
      'Blocked with 409 if a garage vehicle references the model.',
  })
  @ApiOkResponse({ description: 'The deleted model id.' })
  @ApiNotFoundResponse({ description: 'No such model.' })
  @ApiConflictResponse({ description: 'Vehicles reference this model.' })
  remove(@Param('id') id: string) {
    return this.brands.removeModel(id);
  }
}
