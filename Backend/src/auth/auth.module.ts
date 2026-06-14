import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { V1AuthController } from './v1-auth.controller';
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

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({}),
    MailModule,
    SmsModule,
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
  controllers: [AuthController, V1AuthController],
  exports: [RolesGuard, JwtKeyService, JwtModule],
})
export class AuthModule {}
