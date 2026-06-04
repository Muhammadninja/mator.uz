import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AIService } from './ai.service';
import { AIController } from './ai.controller';

@Module({
  imports: [PrismaModule],
  providers: [AIService],
  controllers: [AIController],
})
export class AIModule {}
