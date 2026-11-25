import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { TelegramNotifierModule } from '../telegram/telegram-notifier.module';
import { PhotoRequestsService } from './photo-requests.service';

/**
 * Customer photo requests made through Mator AI. PrismaModule and the
 * ScheduleModule are global; the chat module imports this one to record them.
 */
@Module({
  imports: [NotificationsModule, TelegramNotifierModule],
  providers: [PhotoRequestsService],
  exports: [PhotoRequestsService],
})
export class PhotoRequestsModule {}
