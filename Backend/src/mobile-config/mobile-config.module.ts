import { Module } from '@nestjs/common';

import { MobileConfigController } from './mobile-config.controller';
import { MobileConfigService } from './mobile-config.service';

@Module({
  controllers: [MobileConfigController],
  providers: [MobileConfigService],
})
export class MobileConfigModule {}
