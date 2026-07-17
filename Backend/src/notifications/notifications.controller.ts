import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { ListNotificationsQuery } from './dto/list-notifications.query';
import { TestNotificationDto } from './dto/test-notification.dto';

@ApiTags('Notifications')
@ApiBearerAuth('jwt')
@Controller('v1/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  list(@Request() req: { user: { id: string } }, @Query() query: ListNotificationsQuery) {
    return this.notifications.list(req.user.id, query);
  }

  @Get('preferences')
  @HttpCode(HttpStatus.OK)
  getPreferences(@Request() req: { user: { id: string } }) {
    return this.notifications.getPreferences(req.user.id);
  }

  @Patch('preferences')
  @HttpCode(HttpStatus.OK)
  updatePreferences(
    @Request() req: { user: { id: string } },
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.notifications.updatePreferences(req.user.id, dto);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead(@Request() req: { user: { id: string } }) {
    return this.notifications.markAllRead(req.user.id);
  }

  /**
   * Dev-only: emit a notification to the caller through the real pipeline so the
   * frontend can exercise the inbox and push without triggering a business
   * event. Gated on AUTH_DEV_MODE (the same flag as Phone OTP); when it is off
   * this route 404s and creates nothing. Reuses NotificationsService.emit(), so
   * persistence, preference gating, quiet hours and push delivery are identical
   * to production notifications.
   */
  @Post('test')
  @HttpCode(HttpStatus.CREATED)
  async createTest(
    @Request() req: { user: { id: string } },
    @Body() dto: TestNotificationDto,
  ) {
    if (this.config.get<string>('AUTH_DEV_MODE') !== 'true') {
      throw new NotFoundException('Not found');
    }
    return this.notifications.emit(req.user.id, {
      type: dto.type ?? NotificationType.ORDER_PAID,
      title: dto.title,
      body: dto.body,
      data: dto.data,
      deeplinkPath: dto.deeplink_path ?? null,
    });
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.notifications.markRead(req.user.id, id);
  }
}
