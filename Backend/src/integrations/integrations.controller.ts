import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentDealer } from './decorators/current-dealer.decorator';
import { SyncInventoryResponseDto } from './dto/sync-inventory.response.dto';
import { SyncInventoryDto } from './dto/sync-inventory.dto';
import { API_KEY_HEADER, ApiKeyGuard } from './guards/api-key.guard';
import { IntegrationsService } from './integrations.service';
import type { IntegrationDealer } from './interfaces/integration-dealer.interface';
import { NormalizeSyncBodyPipe } from './normalize-sync-body.pipe';

/**
 * Machine-to-machine integration endpoints for dealers/suppliers.
 *
 * Authenticated by `X-API-KEY` only (see {@link ApiKeyGuard}) — never by a user
 * or admin JWT. A 1C job has no session and no person behind it, so it gets its
 * own credential type whose blast radius is exactly one dealer's own catalog.
 */
@ApiTags('Integrations')
@Controller('v1/integrations/dealers')
@UseGuards(ApiKeyGuard)
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  /**
   * Rate limit well below the global 100/min baseline. A stock sync is a
   * scheduled batch job — a handful of runs an hour, not a stream — and each
   * request may carry thousands of rows, so this bounds how much write load one
   * misconfigured 1C scheduler (or a stolen key) can generate.
   */
  @Post('sync-inventory')
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Синхронизировать складские остатки дилера из 1С.',
    description: [
      'Обновляет остаток (`stockQty`/`inStock`) и учётную цену (`purchasePriceUzs`)',
      'позиций каталога, принадлежащих дилеру, который стоит за `X-API-KEY`.',
      '',
      'Сопоставление идёт по НОРМАЛИЗОВАННОМУ артикулу (верхний регистр, разделители',
      'отброшены) против OEM- и GM-номеров каталога. Позиции, которых у дилера нет,',
      'НЕ создаются — они возвращаются в `skipped`, а счётчики в ответе показывают',
      'расхождение между присланным и применённым.',
      '',
      'Розничная цена (`priceUzs`) не меняется: выгрузка несёт себестоимость, а не',
      'витринную цену.',
      '',
      '`mode=partial` (по умолчанию) трогает только присланные позиции.',
      '`mode=full` считает выгрузку полным складом и обнуляет остальное.',
      '',
      'Тело принимается в двух видах: `{ "items": [...] }` либо голый массив `[...]`.',
    ].join('\n'),
  })
  @ApiHeader({
    name: API_KEY_HEADER,
    description:
      'Секретный ключ интеграции дилера. Выдаётся один раз; хранится на стороне MATOR только в виде SHA-256 хеша.',
    required: true,
    schema: {
      type: 'string',
      example: 'mtr_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    },
  })
  @ApiBody({
    type: SyncInventoryDto,
    description:
      'Выгрузка остатков. Допускается и голый массив позиций — он приводится к `{ items }` до валидации.',
    examples: {
      wrapped: {
        summary: 'Обёрнутая выгрузка с режимом',
        value: {
          mode: 'partial',
          items: [
            {
              article: '96943770',
              title: 'Фильтр масляный Chevrolet Lacetti',
              quantity: 42,
              price: 185000,
              unit: 'шт',
              warehouse: 'SKL-01',
            },
          ],
        },
      },
      bareArray: {
        summary: 'Голый массив (типовая выгрузка 1С)',
        value: [
          {
            oem: '96943770',
            name: 'Фильтр масляный',
            quantity: 42,
            price: 185000,
          },
        ],
      },
    },
  })
  @ApiOkResponse({
    type: SyncInventoryResponseDto,
    description:
      'Синхронизация выполнена. Счётчики показывают, что именно применено.',
  })
  @ApiBadRequestResponse({
    description:
      'Пустой массив, неизвестные поля или непрошедшая валидацию позиция.',
    schema: {
      example: { code: 'VALIDATION_FAILED', message: 'Invalid request.' },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Заголовок X-API-KEY отсутствует или ключ не распознан.',
    schema: {
      example: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key.' },
    },
  })
  @ApiForbiddenResponse({
    description: 'Ключ верный, но дилер не активен (pending/suspended).',
    schema: {
      example: {
        code: 'FORBIDDEN',
        message: 'Dealer account is suspended and cannot sync inventory.',
      },
    },
  })
  @ApiTooManyRequestsResponse({
    description: 'Превышен лимит запросов синхронизации.',
  })
  syncInventory(
    @CurrentDealer() dealer: IntegrationDealer,
    // NormalizeSyncBodyPipe runs FIRST, rewriting a bare array into `{ items }`;
    // the global ValidationPipe then validates the DTO as usual.
    @Body(NormalizeSyncBodyPipe) dto: SyncInventoryDto,
  ): Promise<SyncInventoryResponseDto> {
    return this.integrations.syncInventory(dealer, dto);
  }
}
