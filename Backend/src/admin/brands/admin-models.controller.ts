import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  UseGuards,
  Get,
  ParseIntPipe,
  Query,
  Req,
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
import type { Request } from 'express';
import { AuthenticatedAdmin } from '../auth/strategies/admin-jwt.strategy';
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

  @Get(':id/delete-preview')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'What deleting a model would take with it' })
  @ApiNotFoundResponse({ description: 'No such model.' })
  deletePreview(@Param('id') id: string) {
    return this.brands.modelDeletePreview(id);
  }

  @Delete(':id')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a model (manager or super admin)',
    description:
      'Its fitment bindings cascade, so if any exist their number must be stated in ' +
      '?acceptedFitmentLoss=. Blocked with 409 if a garage vehicle references the model.',
  })
  @ApiOkResponse({ description: 'The deleted model id.' })
  @ApiNotFoundResponse({ description: 'No such model.' })
  @ApiConflictResponse({
    description: 'Vehicles reference this model, or fitment would be lost.',
  })
  remove(
    @Param('id') id: string,
    @Query('acceptedFitmentLoss', new ParseIntPipe({ optional: true }))
    acceptedFitmentLoss: number | undefined,
    @Req() req: Request & { user: AuthenticatedAdmin },
  ) {
    return this.brands.removeModel(id, acceptedFitmentLoss, {
      actor: { id: req.user.id, email: req.user.email, name: req.user.name },
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  }
}
