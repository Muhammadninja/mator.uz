import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { isUzbekLatin } from './uzbek-latin.util';

/**
 * class-validator constraint backing {@link IsUzbekLatin}. Delegates to the
 * shared {@link isUzbekLatin} policy so DTO validation, seeds and data audits
 * enforce the exact same alphabet.
 */
@ValidatorConstraint({ name: 'isUzbekLatin', async: false })
export class IsUzbekLatinConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isUzbekLatin(value);
  }

  defaultMessage(): string {
    return 'must contain only Uzbek Latin characters';
  }
}

/**
 * DTO decorator: the value must be written in Uzbek Latin script (see
 * {@link isUzbekLatin} for the exact alphabet — Latin letters, the Oʻ/Gʻ and
 * tutuq-belgisi apostrophe forms, digits and ordinary punctuation).
 *
 * Deliberately does NOT imply optionality or presence: it validates the VALUE
 * only. A required field pairs it with `@IsNotEmpty()`; an optional one pairs it
 * with `@ValidateIf`/`@IsOptional`, exactly as the surrounding names already do.
 * That keeps "is this field required" and "is this the right script" as two
 * independent rules, each reported under its own constraint key.
 */
export function IsUzbekLatin(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsUzbekLatinConstraint,
    });
  };
}
