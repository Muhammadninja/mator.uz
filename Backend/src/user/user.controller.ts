import {
  Controller,
  Get,
  Patch,
  Body,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserService } from './user.service';
import { UpdateMeDto } from './dto/update-me.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { UpdatePreferencesDto } from '../notifications/dto/update-preferences.dto';

@ApiTags('User')
@ApiBearerAuth('jwt')
@Controller('v1/me')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(
    private readonly users: UserService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  getMe(@Request() req: { user: { id: string } }) {
    return this.users.getMe(req.user.id);
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  updateMe(@Request() req: { user: { id: string } }, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(req.user.id, dto);
  }

  // Notification preferences live in the Notifications domain; expose them here
  // under /v1/me for the frontend contract without duplicating storage.
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
}
