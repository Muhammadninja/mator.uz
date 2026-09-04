import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Transform, Type } from 'class-transformer';
import {
  registerDecorator,
  ValidationOptions,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Largest upload accepted in one request. A dealer with more positions pages
 * the export; the cap exists because the whole batch is validated and written
 * in memory, and an unbounded body is a trivial memory-exhaustion vector on an
 * endpoint that authenticates with a single header.
 */
export const MAX_SYNC_ITEMS = 5000;

/** Upper bound on a single position's quantity and price — a sanity rail against
 *  a misplaced decimal or a 1C unit-conversion bug wiping out a dealer's pricing. */
const MAX_QUANTITY = 1_000_000;
const MAX_PRICE_UZS = 10_000_000_000; // 10 млрд сум

/**
 * How the upload reconciles against what the dealer already has in the catalog.
 *
 * The distinction is load-bearing and cannot be inferred from the payload: an
 * empty-ish upload is either "everything else is out of stock" or "here is page
 * 7 of my export", and guessing wrong either hides a dealer's whole catalog or
 * silently sells parts that are gone.
 */
export enum SyncMode {
  /**
   * Default. Only the positions present in the payload are touched; everything
   * else the dealer has is left exactly as it is. Safe for partial and paged
   * exports — a connection dropped halfway can never zero out a warehouse.
   */
  PARTIAL = 'partial',
  /**
   * The payload is the dealer's COMPLETE stock. Positions absent from it are
   * zeroed (`stockQty = 0`, `inStock = false`) rather than deleted — the part
   * stays in the catalog with its history, images and reviews, and simply reads
   * as out of stock until it comes back. Only correct when 1C sends the entire
   * warehouse in one request.
   */
  FULL = 'full',
}

/**
 * One position of the 1C export.
 *
 * Field names follow what 1C exports actually send. Each has an alias applied at
 * transform time, so a dealer sending `oem`/`name` is accepted identically to
 * one sending `article`/`title` — the two spellings are the same field, not two
 * competing ones, and the DTO stays a single source of truth for validation.
 */
export class SyncInventoryItemDto {
  @ApiProperty({
    description:
      'Каталожный номер / артикул позиции. Принимается также под именем `oem`. ' +
      'Нормализуется (верхний регистр, без разделителей) перед сопоставлением с каталогом.',
    example: '96943770',
    maxLength: 64,
  })
  @Expose()
  // 1C exports call this `article` or `oem` depending on the configuration; both
  // name the same catalog number, so either is accepted into the one field.
  @Transform(
    ({ value, obj }: { value: unknown; obj: Record<string, unknown> }) => {
      const raw = value ?? obj.oem ?? obj.Article ?? obj.OEM;
      return typeof raw === 'string' ? raw.trim() : raw;
    },
    { toClassOnly: true },
  )
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  article!: string;

  @ApiProperty({
    description: 'Наименование позиции. Принимается также под именем `name`.',
    example: 'Фильтр масляный Chevrolet Lacetti',
    maxLength: 255,
  })
  @Expose()
  @Transform(
    ({ value, obj }: { value: unknown; obj: Record<string, unknown> }) => {
      const raw = value ?? obj.name ?? obj.Title ?? obj.Name;
      return typeof raw === 'string' ? raw.trim() : raw;
    },
    { toClassOnly: true },
  )
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title!: string;

  @ApiProperty({
    description: 'Свободный остаток на складе (целое, ≥ 0).',
    example: 42,
    minimum: 0,
  })
  @Expose()
  // 1C commonly serializes numerics as strings ("42", "42.00"). Coerce here so a
  // string-typed quantity is accepted, while a non-numeric value still fails
  // @IsInt below rather than silently becoming NaN.
  @Transform(({ value }: { value: unknown }) => toFiniteNumber(value), {
    toClassOnly: true,
  })
  @IsInt()
  @Min(0)
  @Max(MAX_QUANTITY)
  quantity!: number;

  @ApiProperty({
    description:
      'Учётная / оптовая цена в сумах (≥ 0, до 2 знаков после запятой).',
    example: 185000,
    minimum: 0,
  })
  @Expose()
  @Transform(({ value }: { value: unknown }) => toFiniteNumber(value), {
    toClassOnly: true,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE_UZS)
  price!: number;

  @ApiPropertyOptional({
    description: 'Единица измерения, как её называет 1С.',
    example: 'шт',
    maxLength: 16,
  })
  @Expose()
  @IsOptional()
  @IsString()
  @MaxLength(16)
  unit?: string;

  @ApiPropertyOptional({
    description: 'Код или наименование склада отгрузки.',
    example: 'SKL-01',
    maxLength: 64,
  })
  @Expose()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  warehouse?: string;
}

/**
 * Body of POST /v1/integrations/dealers/sync-inventory.
 *
 * 1C configurations differ in whether they wrap the export: some POST
 * `{ "items": [...] }`, others POST a bare `[ {...}, {...} ]`. Both are accepted
 * — {@link NormalizeSyncBodyPipe} rewrites a bare array into `{ items }` BEFORE
 * validation, so this class stays the single schema and a bare-array upload is
 * validated exactly as strictly as a wrapped one.
 *
 * The global ValidationPipe runs with `whitelist: true, forbidNonWhitelisted:
 * true`, so this class IS the accepted-field whitelist.
 */
export class SyncInventoryDto {
  @ApiProperty({
    type: [SyncInventoryItemDto],
    description: `Позиции номенклатуры (1…${MAX_SYNC_ITEMS}).`,
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'items must contain at least one position' })
  @ArrayMaxSize(MAX_SYNC_ITEMS)
  // @ValidateNested does not reject an element that is an ARRAY rather than an
  // object — a doubly-wrapped body (`[[{…}]]`, which a misconfigured export can
  // produce) would otherwise validate clean and reach the service with every
  // field undefined. Reject the shape here, at the boundary, so it is a 400
  // instead of a sync that silently reports every position as unusable.
  @IsObjectItem({ each: true })
  @ValidateNested({ each: true })
  @Type(() => SyncInventoryItemDto)
  items!: SyncInventoryItemDto[];

  @ApiPropertyOptional({
    enum: SyncMode,
    default: SyncMode.PARTIAL,
    description:
      '`partial` (по умолчанию) — обновляются только присланные позиции. ' +
      '`full` — присланная выгрузка считается ПОЛНЫМ складом: всё остальное обнуляется.',
  })
  @IsOptional()
  @IsEnum(SyncMode)
  mode?: SyncMode;
}

/**
 * Each element must be a plain object. Guards the gap @ValidateNested leaves:
 * an array (or any non-object) element passes nested validation vacuously,
 * because there are no decorated properties on it to check.
 */
function IsObjectItem(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isObjectItem',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === 'object' && value !== null && !Array.isArray(value),
        defaultMessage: () => 'each position must be an object',
      },
    });
  };
}

/**
 * Coerce a 1C numeric to a number without inventing values: a numeric string
 * (with an optional comma decimal separator, as ru-RU locales export) becomes a
 * number, and anything else is passed through untouched so the validator — not
 * this transform — decides it is invalid. Never returns NaN, which would slip
 * past a naive `Number()` and reach the database.
 */
function toFiniteNumber(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : value;
}
