import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * class-validator constraint backing {@link NoDuplicateDocumentTypes}. Operates
 * on the raw array so it runs whether or not the nested items themselves
 * validate; items without a usable `type` are ignored here and reported by
 * their own @IsEnum instead.
 */
@ValidatorConstraint({ name: 'noDuplicateDocumentTypes', async: false })
export class NoDuplicateDocumentTypesConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown): boolean {
    if (!Array.isArray(value)) return true; // @IsArray reports this instead.
    const types = value
      .map((item) => (item as { type?: unknown } | null)?.type)
      .filter((t): t is string => typeof t === 'string');
    return new Set(types).size === types.length;
  }

  defaultMessage(): string {
    return 'acceptances must not contain the same document type more than once';
  }
}

/**
 * DTO decorator: no document `type` may appear twice in the array.
 *
 * A request naming PRIVACY_POLICY at both v1 and v2 is self-contradictory — the
 * user cannot have accepted two versions in one click. Resolving it by taking
 * the last (or first) entry would silently record consent the user never gave,
 * so the whole request is rejected instead.
 */
export function NoDuplicateDocumentTypes(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: NoDuplicateDocumentTypesConstraint,
    });
  };
}
