import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { QueueMonitorService } from './queue-monitor.service';

/**
 * Machine-readable queue counts for the API-authenticated admin client — the
 * same numbers the monitor evaluates, exposed as JSON.
 *
 * This is the JWT/ADMIN-guarded counterpart to the Bull Board UI (which uses
 * Basic Auth because a browser can't attach a Bearer token; see
 * BullBoardAuthMiddleware). Read-only: it triggers a sample and returns it.
 */
@ApiTags('Admin')
@ApiBearerAuth('jwt')
@Controller('api/admin/queues')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@SkipThrottle()
export class QueueHealthController {
  constructor(private readonly monitor: QueueMonitorService) {}

  @Get('health')
  @HttpCode(HttpStatus.OK)
  async health() {
    const queues = await this.monitor.sweep();
    return {
      status: 'ok',
      queues,
      checkedAt: new Date().toISOString(),
    };
  }
}
