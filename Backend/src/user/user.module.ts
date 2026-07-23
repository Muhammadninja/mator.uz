import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AddressesModule } from '../addresses/addresses.module';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { UserService } from './user.service';
import { AvatarService } from './avatar.service';
import { PhoneChangeService } from './phone-change.service';
import { UserController } from './user.controller';

@Module({
  // CloudinaryModule is @Global (available app-wide), but it is imported here
  // explicitly so the module is self-contained: AvatarService's dependency on
  // CloudinaryService is declared where it is used and resolves even in an
  // isolated UserModule test harness.
  imports: [PrismaModule, AuthModule, NotificationsModule, AddressesModule, CloudinaryModule],
  providers: [UserService, AvatarService, PhoneChangeService],
  controllers: [UserController],
})
export class UserModule {}
