import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AiAdvisorService } from './ai-advisor.service';
import { ClaudeService } from './claude.service';
import { AiAdvisorController } from './ai-advisor.controller';

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  providers: [AiAdvisorService, ClaudeService],
  controllers: [AiAdvisorController],
})
export class AiAdvisorModule {}
