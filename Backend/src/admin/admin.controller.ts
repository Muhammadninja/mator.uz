import {
  Controller,
  Get,
  Patch,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  Query,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SellerStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminService } from './admin.service';

@ApiTags('Admin')
@ApiBearerAuth('jwt')
@Controller('api/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('sellers')
  @HttpCode(HttpStatus.OK)
  listSellers(
    @Query('status', new ParseEnumPipe(SellerStatus, { optional: true }))
    status?: SellerStatus,
  ) {
    return this.adminService.listSellers(status);
  }

  @Get('sellers/pending')
  @HttpCode(HttpStatus.OK)
  listPending() {
    return this.adminService.listPending();
  }

  @Patch('sellers/:id/approve')
  @HttpCode(HttpStatus.OK)
  approveSeller(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: { user?: { id?: string } },
  ) {
    return this.adminService.approveSeller(id, req.user?.id);
  }

  @Patch('sellers/:id/reject')
  @HttpCode(HttpStatus.OK)
  rejectSeller(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: { user?: { id?: string } },
  ) {
    return this.adminService.rejectSeller(id, req.user?.id);
  }
}
