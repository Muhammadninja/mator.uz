import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One position the sync could not apply, with the reason. */
export class SyncSkippedItemDto {
  @ApiProperty({
    description: 'Артикул как он пришёл из 1С.',
    example: 'XYZ-999',
  })
  article!: string;

  @ApiProperty({
    description:
      '`unknown_article` — позиции нет в каталоге этого дилера; ' +
      '`unusable_article` — артикул не содержит ни латинских букв, ни цифр ' +
      '(например, кириллический код), поэтому поиск по нему невозможен в принципе.',
    example: 'unknown_article',
    enum: ['unknown_article', 'unusable_article'],
  })
  reason!: string;
}

/**
 * Response of POST /v1/integrations/dealers/sync-inventory.
 *
 * `processedCount` is the number of catalog positions actually WRITTEN — not
 * the number received. The two differ whenever the upload contains articles the
 * dealer does not have in the catalog, and a 1C operator needs that difference
 * visible: a sync that silently reports success for 1500 positions while
 * matching 4 of them is the failure mode this response exists to prevent.
 */
export class SyncInventoryResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: 'Inventory synchronized successfully' })
  message!: string;

  @ApiProperty({
    description: 'Сколько позиций каталога фактически обновлено.',
    example: 1500,
  })
  processedCount!: number;

  @ApiProperty({
    description: 'Сколько позиций пришло в запросе (после валидации).',
    example: 1512,
  })
  receivedCount!: number;

  @ApiProperty({
    description:
      'Сколько позиций НЕ применено: нет в каталоге либо артикул непригоден для поиска. ' +
      'Повторы артикула сюда НЕ входят — их остатки суммируются, а не отбрасываются.',
    example: 12,
  })
  skippedCount!: number;

  @ApiProperty({
    description:
      'Сколько строк выгрузки было объединено в уже учтённые позиции (повтор артикула ' +
      'или второй номер той же детали). Их количества просуммированы, ничего не потеряно.',
    example: 3,
  })
  mergedCount!: number;

  @ApiProperty({
    description:
      'Сколько позиций обнулено как отсутствующие в выгрузке. Всегда 0 при mode=partial. ' +
      'Также 0, если выгрузка в режиме full не совпала НИ С ОДНОЙ позицией каталога — ' +
      'в этом случае обнуление не выполняется, чтобы сломанная выгрузка не стёрла склад.',
    example: 0,
  })
  zeroedCount!: number;

  @ApiPropertyOptional({
    type: [SyncSkippedItemDto],
    description:
      'Первые пропущенные позиции с причиной (список усечён, чтобы ответ не рос без границ).',
  })
  skipped?: SyncSkippedItemDto[];

  @ApiProperty({ description: 'Длительность обработки, мс.', example: 842 })
  durationMs!: number;

  @ApiProperty({ example: '2026-09-04T20:30:00.000Z' })
  timestamp!: string;
}
