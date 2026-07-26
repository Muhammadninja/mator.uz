import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AdminAuditAction, AdminRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../../auth/password.util';
import { AdminAuditActor, AdminAuditService } from './admin-audit.service';
import {
  AdminSessionContext,
  AdminTokenService,
  IssuedAdminSession,
} from './admin-token.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AuthenticatedAdmin } from './strategies/admin-jwt.strategy';

/**
 * An Argon2id hash of a value nobody knows, verified against when the email is
 * unknown. Without it, "no such admin" returns in ~0ms while "wrong password"
 * pays the full KDF cost, and that timing difference enumerates which emails are
 * administrators.
 *
 * Generated with the same parameters password.util.ts uses, so the dummy path
 * costs the same as a real verification.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$gc69rDtsyU1zsc6ub4dgZA$4iGl2DEjIBLla6mfuDgPJbJYc/zPGJB2etJ3VOETWvk';

/**
 * Who performed an administrator-mutating action, and from where — attached to
 * the audit entry. `actorLabel` covers actions with no signed-in admin (the CLI
 * bootstrap of the first SUPER_ADMIN).
 */
export interface AdminAuditContext {
  actor?: AdminAuditActor | null;
  actorLabel?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Admin-panel authentication: email + password only. This service never touches
 * app_users, phone OTP, or any mobile-app flow — the two identity spaces are
 * fully separate (see admin-token.service.ts for the token side).
 *
 * Logging discipline: passwords, hashes, and tokens are NEVER logged, in any
 * branch. Failure logs carry the email (an operational necessity for auditing
 * brute-force attempts) and nothing else.
 */
@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AdminTokenService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Hash a plaintext admin password. Delegates to the project-wide password
   * utility (Argon2id, OWASP-recommended) rather than owning a second, divergent
   * hashing policy — a KDF upgrade there now covers admins automatically.
   */
  static hashPassword(plain: string): Promise<string> {
    return hashPassword(plain);
  }

  /**
   * Verify credentials and open a session.
   *
   * Wrong email and wrong password deliberately produce the SAME error and take
   * the same time, so the endpoint does not disclose which admin emails exist.
   * A deactivated account is told so explicitly — it has already proven the
   * password, so there is nothing left to leak, and a silent generic failure
   * would be a support burden.
   */
  async login(
    dto: AdminLoginDto,
    context: AdminSessionContext = {},
  ): Promise<IssuedAdminSession> {
    const admin = await this.prisma.appAdmin.findUnique({
      where: { email: dto.email },
      select: {
        id: true,
        passwordHash: true,
        role: true,
        isActive: true,
        tokenVersion: true,
      },
    });

    const passwordMatches = await verifyPassword(
      admin?.passwordHash ?? DUMMY_HASH,
      dto.password,
    );

    if (!admin || !passwordMatches) {
      this.logger.warn(`Failed admin login attempt for ${dto.email}`);
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!admin.isActive) {
      this.logger.warn(
        `Login attempt on deactivated admin account ${dto.email}`,
      );
      throw new UnauthorizedException('Account is deactivated');
    }

    // Transparently upgrade a legacy bcrypt hash to Argon2id on successful
    // login — the same policy AuthService applies to users. Relevant for
    // accounts bootstrapped by an older build of the CLI script; new accounts
    // are already Argon2id. Best-effort: a failed upgrade must not cost a valid
    // admin their login, since the password itself already verified.
    if (needsRehash(admin.passwordHash)) {
      await this.prisma.appAdmin
        .update({
          where: { id: admin.id },
          data: { passwordHash: await hashPassword(dto.password) },
        })
        .then(() =>
          this.logger.log(`Upgraded password hash for admin ${admin.id}`),
        )
        .catch((err: unknown) =>
          this.logger.warn(
            `Could not upgrade password hash for admin ${admin.id}: ${String(err)}`,
          ),
        );
    }

    // Best-effort audit stamp: a failure here must not cost a valid admin their
    // login, so it is logged and swallowed rather than propagated.
    await this.prisma.appAdmin
      .update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } })
      .catch((err: unknown) =>
        this.logger.warn(
          `Could not update lastLoginAt for admin ${admin.id}: ${String(err)}`,
        ),
      );

    this.logger.log(`Admin ${admin.id} logged in`);
    // A new session per login — signing in from another device never displaces
    // an existing one.
    return this.tokens.issueSession(
      {
        id: admin.id,
        role: admin.role,
        tokenVersion: admin.tokenVersion,
      },
      context,
    );
  }

  /** Rotate a refresh token into a brand-new pair; the presented one dies here. */
  refresh(refreshToken: string): Promise<IssuedAdminSession> {
    return this.tokens.rotate(refreshToken);
  }

  /**
   * Log out: invalidate the presented refresh token so it can no longer be
   * rotated. Other sessions this admin has open elsewhere are left alone.
   */
  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revoke(refreshToken);
  }

  /** The admin's live sessions (one per signed-in device), newest first. */
  listSessions(adminId: string) {
    return this.tokens.listSessions(adminId);
  }

  /** End one session by id ("sign out this device"). Scoped to the caller. */
  async revokeSession(adminId: string, sessionId: number): Promise<void> {
    const revoked = await this.tokens.revokeSession(adminId, sessionId);
    if (!revoked) {
      // Covers "not found", "already revoked" and "belongs to another admin"
      // with one response, so session ids of other accounts cannot be probed.
      throw new NotFoundException('Session not found');
    }
    this.logger.log(`Admin ${adminId} revoked session ${sessionId}`);
  }

  /**
   * The authenticated admin, straight from the strategy's request principal —
   * already stripped of passwordHash and tokenVersion at that boundary, so there
   * is no sensitive field left to leak here.
   */
  me(admin: AuthenticatedAdmin): AuthenticatedAdmin {
    return admin;
  }

  /**
   * Create an administrator. Used by the CLI bootstrap script and (later) by
   * SUPER_ADMIN-gated management endpoints — there is deliberately NO public
   * registration route.
   */
  async createAdmin(
    params: {
      email: string;
      password: string;
      name: string;
      role?: AdminRole;
    },
    audit: AdminAuditContext = {},
  ): Promise<{ id: string; email: string; name: string; role: AdminRole }> {
    const passwordHash = await AdminAuthService.hashPassword(params.password);

    // The account row and its audit entry commit together: an admin can never
    // come into existence without a record of who created it.
    return this.prisma.$transaction(async (tx) => {
      const admin = await tx.appAdmin.create({
        data: {
          email: params.email.trim().toLowerCase(),
          passwordHash,
          name: params.name.trim(),
          role: params.role ?? AdminRole.OPERATOR,
        },
        select: { id: true, email: true, name: true, role: true },
      });

      await this.audit.record(
        {
          action: AdminAuditAction.CREATE_ADMIN,
          ...audit,
          target: admin,
          newRole: admin.role,
        },
        tx,
      );

      this.logger.log(`Admin account created: ${admin.id} (${admin.role})`);
      return admin;
    });
  }

  /**
   * Change an admin's password. Every existing session is revoked afterwards —
   * a password change must not leave old tokens alive.
   *
   * `RESET_PASSWORD` is recorded when someone changes another admin's password;
   * `CHANGE_PASSWORD` when they change their own. The distinction matters in an
   * audit: an administrator resetting a colleague's credential is a different
   * event from that colleague rotating their own.
   */
  async changePassword(
    adminId: string,
    newPassword: string,
    audit: AdminAuditContext = {},
  ): Promise<void> {
    const target = await this.requireAdmin(adminId);
    const passwordHash = await AdminAuthService.hashPassword(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.appAdmin.update({
        where: { id: adminId },
        data: { passwordHash },
      });
      await this.audit.record(
        {
          action:
            audit.actor && audit.actor.id !== adminId
              ? AdminAuditAction.RESET_PASSWORD
              : AdminAuditAction.CHANGE_PASSWORD,
          ...audit,
          target,
        },
        tx,
      );
    });

    // After the commit: revocation bumps tokenVersion, and doing it inside the
    // transaction would hide that bump from other connections until commit.
    await this.tokens.revokeAllSessions(adminId);
    this.logger.log(
      `Password changed for admin ${adminId}; all sessions revoked`,
    );
  }

  /**
   * Change an administrator's role. Every session is revoked afterwards, so the
   * new privileges take effect from a fresh login rather than being carried by
   * a token minted under the old role.
   */
  async changeRole(
    adminId: string,
    newRole: AdminRole,
    audit: AdminAuditContext = {},
  ): Promise<void> {
    const target = await this.requireAdmin(adminId);
    if (target.role === newRole) return; // no-op: nothing to audit.

    await this.prisma.$transaction(async (tx) => {
      await tx.appAdmin.update({
        where: { id: adminId },
        data: { role: newRole },
      });
      await this.audit.record(
        {
          action: AdminAuditAction.CHANGE_ROLE,
          ...audit,
          target,
          previousRole: target.role,
          newRole,
        },
        tx,
      );
    });

    await this.tokens.revokeAllSessions(adminId);
    this.logger.log(
      `Admin ${adminId} role changed ${target.role} -> ${newRole}; all sessions revoked`,
    );
  }

  /**
   * Deactivate an administrator, ending every session they hold.
   *
   * The flag alone is already enough to stop them: AdminJwtStrategy re-reads
   * `isActive` on EVERY authenticated request, so a live access token dies on
   * its next use rather than at the end of its TTL. Revoking on top of that
   * does two further things — it drops the refresh rows (which would otherwise
   * sit there until they expired) and bumps the session version, so nothing is
   * left that could be rotated or replayed.
   */
  async deactivate(
    adminId: string,
    audit: AdminAuditContext = {},
  ): Promise<void> {
    const target = await this.requireAdmin(adminId);

    await this.prisma.$transaction(async (tx) => {
      await tx.appAdmin.update({
        where: { id: adminId },
        data: { isActive: false },
      });
      await this.audit.record(
        { action: AdminAuditAction.DEACTIVATE_ADMIN, ...audit, target },
        tx,
      );
    });

    await this.tokens.revokeAllSessions(adminId);
    this.logger.log(`Admin ${adminId} deactivated; all sessions revoked`);
  }

  /** Re-enable a deactivated administrator. They must log in again. */
  async reactivate(
    adminId: string,
    audit: AdminAuditContext = {},
  ): Promise<void> {
    const target = await this.requireAdmin(adminId);

    await this.prisma.$transaction(async (tx) => {
      await tx.appAdmin.update({
        where: { id: adminId },
        data: { isActive: true },
      });
      await this.audit.record(
        { action: AdminAuditAction.REACTIVATE_ADMIN, ...audit, target },
        tx,
      );
    });
    this.logger.log(`Admin ${adminId} reactivated`);
  }

  /**
   * Delete an administrator outright.
   *
   * The audit entry is written BEFORE the delete, inside the same transaction:
   * the FK is ON DELETE SET NULL, so the row survives with its snapshot columns
   * intact and the deletion stays on record. Refresh tokens cascade away with
   * the account.
   */
  async deleteAdmin(
    adminId: string,
    audit: AdminAuditContext = {},
  ): Promise<void> {
    const target = await this.requireAdmin(adminId);

    await this.prisma.$transaction(async (tx) => {
      await this.audit.record(
        { action: AdminAuditAction.DELETE_ADMIN, ...audit, target },
        tx,
      );
      await tx.appAdmin.delete({ where: { id: adminId } });
    });
    this.logger.log(`Admin ${adminId} deleted`);
  }

  /** The audit trail, newest first. */
  listAudit(params: Parameters<AdminAuditService['list']>[0]) {
    return this.audit.list(params);
  }

  /**
   * Load the identity an audit entry snapshots, failing loudly if the account is
   * gone — an audited action must never be attributed to an unknown target.
   */
  private async requireAdmin(adminId: string) {
    const admin = await this.prisma.appAdmin.findUnique({
      where: { id: adminId },
      select: { id: true, email: true, name: true, role: true },
    });
    if (!admin) throw new NotFoundException('Administrator not found');
    return admin;
  }
}
