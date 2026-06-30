import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DevicesService } from './devices.service';
import { RegisterDeviceDto } from './dto/register-device.dto';

@Controller('v1/devices')
@UseGuards(JwtAuthGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post('register')
  @HttpCode(HttpStatus.OK)
  register(@Request() req: { user: { id: string } }, @Body() dto: RegisterDeviceDto) {
    return this.devices.register(req.user.id, dto);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  list(@Request() req: { user: { id: string } }) {
    return this.devices.list(req.user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unregister(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    await this.devices.unregister(req.user.id, id);
  }
}
