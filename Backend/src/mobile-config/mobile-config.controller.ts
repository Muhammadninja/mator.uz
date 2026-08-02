import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { MobileConfigService } from './mobile-config.service';

/**
 * Public mobile app config (no auth) — the client polls this to decide whether a
 * mandatory update is required. Throttle-exempt: it is a tiny, cacheable read hit
 * on cold start.
 */
@ApiTags('App')
@Controller('v1/app')
@SkipThrottle()
export class MobileConfigController {
  constructor(private readonly config: MobileConfigService) {}

  @Get('config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mobile app config — force-update gate, store links + legal URLs.',
    description:
      'privacy_policy_url / terms_url are the stable public URLs the app links ' +
      'to from its legal screen and that App Store Connect requires. They are ' +
      'null until the product/legal owner supplies the documents — the backend ' +
      'never invents legal text — and the client hides the link while null.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        min_supported_version: '1.0.0',
        latest_version: '1.0.0',
        ios_store_url: null,
        android_store_url:
          'https://play.google.com/store/apps/details?id=com.fotih12.mator',
        privacy_policy_url: 'https://mator.uz/legal/privacy',
        terms_url: 'https://mator.uz/legal/terms',
      },
    },
  })
  getConfig() {
    return this.config.getConfig();
  }
}
