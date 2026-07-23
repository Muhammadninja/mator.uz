import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { E164_REGEX } from '../../auth/phone/dto/request-otp.dto';

/**
 * Body for POST /v1/me/phone/request. `phone` is the new number the
 * authenticated user wants to move their account to, in E.164 form
 * (reusing the same {@link E164_REGEX} the sign-in flow validates against).
 */
export class RequestPhoneChangeDto {
  @ApiProperty({
    example: '+998901234567',
    description: 'New phone number in E.164 format.',
  })
  @Matches(E164_REGEX, { message: 'phone must be a valid E.164 number' })
  phone: string;
}
