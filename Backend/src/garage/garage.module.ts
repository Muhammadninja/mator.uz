import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { GarageService } from './garage.service';
import { GarageController } from './garage.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  providers: [GarageService],
  controllers: [GarageController],
})
export class GarageModule {}
