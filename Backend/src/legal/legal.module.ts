import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LegalService } from './legal.service';
import { LegalController } from './legal.controller';

/**
 * Legal documents and consent records. PrismaService comes from the global
 * PrismaModule; AuthModule provides the JWT guard the protected routes use.
 *
 * LegalService is exported so the phone-OTP registration flow can record
 * consent inside the same transaction that creates the account (see
 * PhoneAuthService) instead of duplicating the version-validation rules.
 */
@Module({
  imports: [forwardRef(() => AuthModule)],
  providers: [LegalService],
  controllers: [LegalController],
  exports: [LegalService],
})
export class LegalModule {}
