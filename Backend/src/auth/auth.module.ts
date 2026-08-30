import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RolesGuard } from './guards/roles.guard';
import { GoogleVerifierService } from './social/google-verifier.service';
import { AppleVerifierService } from './social/apple-verifier.service';
import { SocialIdentityService } from './social/social-identity.service';
import { EmailVerificationService } from './email-verification/email-verification.service';
import { JwtKeyService } from './tokens/jwt-key.service';
import { TokenService } from './tokens/token.service';
import { OtpService } from './phone/otp.service';
import { PhoneAuthService } from './phone/phone-auth.service';
import { MyIdService } from './myid/myid.service';
import { MailModule } from '../mail/mail.module';
import { SmsModule } from '../sms/sms.module';
import { LegalModule } from '../legal/legal.module';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({}),
    MailModule,
    SmsModule,
    // forwardRef: LegalModule imports this module for the JWT guard, while
    // PhoneAuthService needs LegalService to record registration consent inside
    // the account-creation transaction.
    forwardRef(() => LegalModule),
  ],
  providers: [
    AuthService,
    JwtStrategy,
    RolesGuard,
    GoogleVerifierService,
    AppleVerifierService,
    SocialIdentityService,
    EmailVerificationService,
    JwtKeyService,
    TokenService,
    OtpService,
    PhoneAuthService,
    MyIdService,
  ],
  controllers: [AuthController],
  // OtpService + TokenService are exported so the profile module can reuse the
  // same OTP issuance/verification and session-revocation logic for the
  // change-phone flow (no duplicated auth logic).
  exports: [RolesGuard, JwtKeyService, JwtModule, OtpService, TokenService],
})
export class AuthModule {}
