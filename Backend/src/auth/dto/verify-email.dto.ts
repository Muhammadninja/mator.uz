import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class VerifyEmailDto {
  // A valid token is 64 hex chars (32 random bytes), but we do NOT enforce the
  // exact length here: a malformed token must still reach the controller so it
  // can redirect to the failure page rather than returning a JSON 400 to a
  // user who clicked the link in their email client. MaxLength caps abuse.
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token: string;
}
