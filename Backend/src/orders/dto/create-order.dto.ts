import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { E164_REGEX } from '../../auth/phone/dto/request-otp.dto';

/** Upper bound on an id the app sends (ids are prefixed ULIDs or UUIDs). */
const ID_MAX = 64;

const lowerCase = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * The checkout selections inside `cart_snapshot` (LOW-ORD-010). Validated as a
 * nested object, so the global `forbidNonWhitelisted` refuses an unknown key
 * here as it does at the top level, and a wrong type is a 400, not a Prisma 500.
 *
 * `null` is accepted wherever the app sends it for "not chosen".
 */
export class CartSnapshotDto {
  /** The buyer's own saved address id; ownership is checked by the service. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX)
  delivery_address_id?: string | null;

  /** Compared case-insensitively, as the app has always sent it. */
  @IsOptional()
  @Transform(lowerCase)
  @IsIn(['courier', 'pickup'])
  delivery_method?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  promo_code?: string | null;

  /**
   * Accepted for older clients and ignored: the order's lines come from the
   * server-side cart, never from the request.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  items?: unknown[];
}

export class CreateOrderDto {
  // { items?, delivery_address_id?, delivery_method?, promo_code? }
  // Items are taken from the server-side cart (source of truth); the snapshot
  // is accepted for delivery/promo context.
  @IsOptional()
  @ValidateNested()
  @Type(() => CartSnapshotDto)
  cart_snapshot?: CartSnapshotDto;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX)
  vehicle_id?: string;

  // E.164, which also keeps it inside the VarChar(20) column.
  @IsOptional()
  @IsString()
  @Matches(E164_REGEX, {
    message: 'contact_phone_e164 must be a valid E.164 number',
  })
  contact_phone_e164?: string;

  // Chosen payment method. Optional for back-compat (older clients omit it);
  // persisted on the order so the payment webhook / reporting know the intent.
  // 'payme' = online, 'terminal' = card reader on delivery, 'cash' = COD.
  @IsOptional()
  @IsIn(['payme', 'terminal', 'cash'])
  payment_type?: 'payme' | 'terminal' | 'cash';

  // The courier price the buyer was shown and agreed to, from POST /v1/shipping/quote.
  // Compared against the price computed for the order and never charged from: see
  // OrdersService.createFromCart.
  @IsOptional()
  @IsInt()
  @Min(0)
  confirmed_delivery_uzs?: number;

  // The `quote_id` of that same answer: says which destination, pickup points and rates the
  // price was for. Compared against the quote computed for the order, never trusted.
  @IsOptional()
  @IsString()
  @MaxLength(128)
  delivery_quote_id?: string;

  // The total the buyer was shown and agreed to. Compared against the total computed for the
  // order and never charged from: see OrdersService.createFromCart. There is no field for a
  // service fee or a total to charge, because no figure from a client is ever charged.
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  confirmed_total_uzs?: number;
}
