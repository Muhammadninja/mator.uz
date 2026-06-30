import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AccountService } from './account.service';
import { AccountController } from './account.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  providers: [AccountService],
  controllers: [AccountController],
})
export class AccountModule {}
