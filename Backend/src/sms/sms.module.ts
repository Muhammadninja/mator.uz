import { Module } from '@nestjs/common';
import { SmsService } from './sms.service';
import { SmsOperatorResolver } from './resolver/sms-operator.resolver';

@Module({
  // PrismaService is provided by the @Global PrismaModule, so it needs no import
  // here. Accounting (SmsService + SmsOperatorResolver) is internal to this
  // module; only SmsService stays exported, so callers are unchanged.
  providers: [SmsService, SmsOperatorResolver],
  exports: [SmsService],
})
export class SmsModule {}
