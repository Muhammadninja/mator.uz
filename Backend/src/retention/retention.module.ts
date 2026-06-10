import { Module } from '@nestjs/common';
import { RetentionService } from './retention.service';

// PrismaModule is @Global and ConfigModule is global, so no imports needed.
// ScheduleModule.forRoot() is registered once in AppModule.
@Module({
  providers: [RetentionService],
})
export class RetentionModule {}
