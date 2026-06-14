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
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { ListNotificationsQuery } from './dto/list-notifications.query';

@Controller('v1/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

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

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.notifications.markRead(req.user.id, id);
  }
}
