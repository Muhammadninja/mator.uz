import { SaleDiscountType } from '@prisma/client';
import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/** The shape both the create and update DTOs expose to this constraint. */
interface DiscountBody {
  discountType?: SaleDiscountType;
  discountValue?: number;
}

/**
 * "A percentage discount cannot exceed 100%" — a rule that spans two fields, so
 * it cannot be a plain `@Max(100)` on discountValue (that would wrongly cap a
 * FIXED discount at 100 UZS).
 *
 * The lower bound (> 0, for both types) is left to `@IsPositive` on the field
 * itself. This constraint owns only the type-dependent ceiling.
 *
 * On a PATCH that changes `discountValue` without restating `discountType`, the
 * type is unknown here — the object simply has no discountType — and the check
 * is deferred rather than guessed. The service re-validates against the sale's
 * stored type, which is the only place both values are known.
 */
@ValidatorConstraint({ name: 'saleDiscountValue', async: false })
export class SaleDiscountValueConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const body = args.object as DiscountBody;
    if (typeof value !== 'number' || !Number.isFinite(value)) return true; // @IsNumber reports it
    if (body.discountType !== SaleDiscountType.PERCENT) return true;
    return value <= 100;
  }

  defaultMessage(): string {
    return 'discountValue must not exceed 100 for a PERCENT sale';
  }
}
