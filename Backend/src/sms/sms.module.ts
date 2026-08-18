import { Module } from '@nestjs/common';
import { SmsService } from './sms.service';
import { SmsOperatorResolver } from './resolver/sms-operator.resolver';
import { EskizWebhookController } from './eskiz-webhook.controller';

@Module({
  // PrismaService is provided by the @Global PrismaModule, so it needs no import
  // here. Accounting (SmsService + SmsOperatorResolver) is internal to this
  // module; only SmsService stays exported, so callers are unchanged.
  //
  // The webhook controller lives here (not in a separate module) so it shares
  // the single SmsService instance that owns the ledger. SmsModule is already
  // imported by AuthModule and QueueModule, so the route registers without any
  // change to app.module.ts.
  controllers: [EskizWebhookController],
  providers: [SmsService, SmsOperatorResolver],
  exports: [SmsService],
})
export class SmsModule {}
