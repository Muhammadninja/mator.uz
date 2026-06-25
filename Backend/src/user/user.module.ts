import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UserService } from './user.service';
import { UserController } from './user.controller';

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  providers: [UserService],
  controllers: [UserController],
})
export class UserModule {}
