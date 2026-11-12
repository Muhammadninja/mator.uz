import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { VehiclesService } from './vehicles/vehicles.service';
import { VehiclesController } from './vehicles/vehicles.controller';
import { VehicleImagePipelineClient } from './vehicle-images/vehicle-image.pipeline-client';
import { VehicleImageDeliveryService } from './vehicle-images/vehicle-image.delivery.service';
import { VehicleImagesService } from './vehicle-images/vehicle-images.service';
import { VehicleImagesProcessor } from './vehicle-images/vehicle-images.processor';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    RealtimeModule,
    NotificationsModule,
    // The dedicated vehicle-images queue lives with its only producer and worker,
    // like `alerts` in AlertingModule. The connection comes from QueueModule.forRootAsync.
    BullModule.registerQueue({ name: QUEUE_NAMES.VEHICLE_IMAGES }),
  ],
  providers: [
    VehiclesService,
    VehicleImagePipelineClient,
    VehicleImageDeliveryService,
    VehicleImagesService,
    VehicleImagesProcessor,
  ],
  controllers: [VehiclesController],
})
export class GarageModule {}
