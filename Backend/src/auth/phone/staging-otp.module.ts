import { Module } from '@nestjs/common';
import { AuthModule } from '../auth.module';
import { StagingOtpController } from './staging-otp.controller';

/**
 * Mounts the staging tester inbox on its own, so AuthModule keeps serving only
 * AuthController. The route answers 404 unless staging tester OTP is enabled
 * (staging-otp.config.ts) and the request comes through the staging proxy.
 */
@Module({
  imports: [AuthModule],
  controllers: [StagingOtpController],
})
export class StagingOtpModule {}
