import {
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** Body of POST /v1/orders/:id/offline-collection. */
export class RecordOfflineCollectionDto {
  /** What was received, in UZS. Stated by the operator and checked against the order. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amountUzs: number;

  /** The terminal slip or cash document. Required for a terminal payment. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  /** The number of a receipt issued outside Mator, if the operator has one. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fiscalReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
