import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/** The shape both the create and update DTOs expose to this constraint. */
interface WindowBody {
  startAt?: string;
}

/**
 * "endAt must not precede startAt" — a two-field rule, so it lives here rather
 * than on either field alone. Declared on `endAt`, and satisfied vacuously when
 * endAt is absent (an open-ended sale) or when the pair is not comparable.
 *
 * A PATCH that moves only one end of the window leaves the other unknown here;
 * the service re-checks the merged window against the stored row, which is the
 * only place both ends are known. This constraint is the fast path for the
 * common case where a body carries both.
 */
@ValidatorConstraint({ name: 'saleWindow', async: false })
export class SaleWindowConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (typeof value !== 'string') return true; // @IsDateString reports it
    const start = (args.object as WindowBody).startAt;
    if (typeof start !== 'string') return true; // deferred to the service

    const endMs = Date.parse(value);
    const startMs = Date.parse(start);
    if (Number.isNaN(endMs) || Number.isNaN(startMs)) return true;

    return endMs >= startMs;
  }

  defaultMessage(): string {
    return 'endAt must be the same as or after startAt';
  }
}
