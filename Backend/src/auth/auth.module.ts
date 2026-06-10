import { Module } from '@nestjs/common';
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
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({}),
    MailModule,
  ],
  providers: [
    AuthService,
    JwtStrategy,
    RolesGuard,
    GoogleVerifierService,
    AppleVerifierService,
    SocialIdentityService,
    EmailVerificationService,
  ],
  controllers: [AuthController],
  exports: [RolesGuard],
})
export class AuthModule {}
