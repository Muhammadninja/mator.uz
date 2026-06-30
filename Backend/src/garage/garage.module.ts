import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { VehiclesService } from './vehicles/vehicles.service';
import { VehiclesController } from './vehicles/vehicles.controller';

@Module({
  imports: [PrismaModule, AuthModule, RealtimeModule, NotificationsModule],
  providers: [VehiclesService],
  controllers: [VehiclesController],
})
export class GarageModule {}
