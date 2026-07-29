import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PrismaModule } from '../../prisma/prisma.module';
import { MailModule } from '../../mail/mail.module';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuthConfig } from './admin-auth.config';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminInviteController } from './admin-invite.controller';
import { AdminInviteService } from './admin-invite.service';
import { AdminTokenService } from './admin-token.service';
import { AdminJwtGuard } from './guards/admin-jwt.guard';
import { AdminRoleGuard } from './guards/admin-role.guard';
import { AdminJwtStrategy } from './strategies/admin-jwt.strategy';

/**
 * Admin-panel authentication (email + password, separate JWT secret).
 *
 * Self-contained on purpose: it does NOT import AuthModule, so nothing here can
 * reach the mobile app's RS256 keys, OTP services or user session logic — and
 * the mobile flow is equally unable to reach the admin side.
 *
 * PassportModule is registered WITHOUT `defaultStrategy`, so registering the
 * `admin-jwt` strategy cannot alter the app-wide default (`jwt`) that the
 * mobile-facing guards rely on.
 *
 * Exported: AdminJwtGuard + AdminRoleGuard, so any admin controller can gate
 * itself with `@UseGuards(AdminJwtGuard, AdminRoleGuard)` + `@Roles(...)`.
 *
 * ConfigModule is imported explicitly rather than leaning on AppModule having
 * registered it globally: AdminAuthConfig needs ConfigService to resolve the
 * admin secret, and a module whose auth stack silently fails to instantiate
 * outside one particular parent is a trap. Importing an already-global module
 * is a no-op, so this costs nothing where it is already available.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    PassportModule,
    JwtModule.register({}),
    MailModule,
  ],
  providers: [
    AdminAuditService,
    AdminAuthConfig,
    AdminAuthService,
    AdminInviteService,
    AdminTokenService,
    AdminJwtStrategy,
    AdminJwtGuard,
    AdminRoleGuard,
  ],
  controllers: [AdminAuthController, AdminInviteController],
  exports: [
    AdminAuthService,
    AdminAuditService,
    AdminTokenService,
    AdminJwtGuard,
    AdminRoleGuard,
  ],
})
export class AdminAuthModule {}
