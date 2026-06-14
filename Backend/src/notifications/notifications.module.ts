import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { DevicesService } from './devices.service';
import { DevicesController } from './devices.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { PushDispatchService } from './push/push-dispatch.service';
import { ExpoPushProvider } from './push/providers/expo.provider';
import { FcmPushProvider } from './push/providers/fcm.provider';
import { ApnsPushProvider } from './push/providers/apns.provider';

@Module({
  imports: [PrismaModule, AuthModule],
  providers: [
    DevicesService,
    NotificationsService,
    PushDispatchService,
    ExpoPushProvider,
    FcmPushProvider,
    ApnsPushProvider,
  ],
  controllers: [DevicesController, NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
