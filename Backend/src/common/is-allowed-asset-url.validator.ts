import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { isAllowedAssetUrl } from './asset-url.util';

/**
 * class-validator constraint backing {@link IsAllowedAssetUrl}. Delegates to the
 * shared {@link isAllowedAssetUrl} policy so DTO validation and service-level
 * checks enforce the exact same trusted-host allowlist.
 */
@ValidatorConstraint({ name: 'isAllowedAssetUrl', async: false })
export class IsAllowedAssetUrlConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isAllowedAssetUrl(value);
  }

  defaultMessage(): string {
    return 'must be an HTTPS URL on an allowed asset host';
  }
}

/**
 * DTO decorator: the value must be an HTTPS URL whose host is on the configured
 * `ASSET_URL_ALLOWED_HOSTS` allowlist. Rejects arbitrary external URLs.
 */
export function IsAllowedAssetUrl(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsAllowedAssetUrlConstraint,
    });
  };
}
