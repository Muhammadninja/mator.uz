import { IsString, IsNotEmpty } from 'class-validator';

export class GoogleLoginDto {
  /** The Google ID token (JWT) obtained by the mobile app via Google Sign-In. */
  @IsString()
  @IsNotEmpty()
  idToken: string;
}
