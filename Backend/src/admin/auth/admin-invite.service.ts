import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AdminAuditAction, AdminRole, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditContext, AdminAuthService } from './admin-auth.service';
import {
  AdminSessionContext,
  AdminTokenService,
  IssuedAdminSession,
} from './admin-token.service';

/** Invite lifetime — a taklif link is valid for 48 hours from creation. */
const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

/** The invite preview a public caller may see: who it is for, and what role. */
export interface AdminInvitePreview {
  email: string;
  role: AdminRole;
}

/**
 * Invite-only admin signup. A SUPER_ADMIN invites a specific email; a one-time,
 * expiring link is emailed; the invitee sets a password and their admin account
 * is created and they are logged straight in.
 *
 * Security posture mirrors the refresh-token design (admin-token.service.ts):
 *
 *   • Only the SHA-256 hash of the opaque token is ever stored. The raw token
 *     exists solely in the emailed link, so a leaked DB row cannot be turned
 *     back into a usable invite. It is NEVER returned in any response body.
 *   • Single-use: `acceptedAt` is stamped on acceptance and a used invite is
 *     rejected as "not found" thereafter.
 *   • Short-lived: 48h expiry, checked on both preview and accept.
 *   • Missing/expired/accepted all collapse to 404, so a token cannot be probed.
 *
 * Nothing here re-implements hashing or session issuance: account creation goes
 * through AdminAuthService.createAdmin (Argon2id + CREATE_ADMIN audit in one
 * transaction) and the session is issued exactly as login() does, via
 * AdminTokenService.issueSession.
 */
@Injectable()
export class AdminInviteService {
  private readonly logger = new Logger(AdminInviteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminAuth: AdminAuthService,
    private readonly tokens: AdminTokenService,
    private readonly audit: AdminAuditService,
    private readonly mail: MailService,
  ) {}

  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  /**
   * Create (or replace) an invite for one email and send the link.
   *
   * @throws ConflictException if an admin with that email already exists.
   * @throws ServiceUnavailableException (from MailService) if email is unconfigured.
   */
  async createInvite(
    params: { email: string; role?: AdminRole; inviter: AdminAuditContext['actor'] },
    audit: AdminAuditContext,
  ): Promise<void> {
    const email = params.email.trim().toLowerCase();
    const role = params.role ?? AdminRole.OPERATOR;

    // An email that already has an active admin account cannot be re-invited —
    // there is nothing to create. A deactivated account is still an account, so
    // this also refuses re-inviting one (re-activate it via management instead).
    const existing = await this.prisma.appAdmin.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'An administrator with this email already exists',
      );
    }

    // Opaque, high-entropy token. Only its hash is stored; the raw value leaves
    // this process only inside the emailed link.
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    // Replace any pending invite for this email so a second invite supersedes the
    // first (the old link stops working). Done in one transaction with the audit
    // write so an invite never exists without a record of who issued it.
    await this.prisma.$transaction(async (tx) => {
      await tx.adminInvite.deleteMany({ where: { email, acceptedAt: null } });
      await tx.adminInvite.create({
        data: {
          email,
          tokenHash,
          role,
          invitedById: params.inviter?.id ?? null,
          expiresAt,
        },
      });
      await this.audit.record(
        {
          action: AdminAuditAction.INVITE_ADMIN,
          ...audit,
          // The invitee has no account yet, so the target is the email itself —
          // snapshotted like any other audit target so the entry stays readable.
          target: { id: email, email, name: email },
          newRole: role,
        },
        tx,
      );
    });

    // Send AFTER the row commits: a failed send throws and the caller sees 503,
    // but the invite row is already persisted, so a retry (re-invite) simply
    // supersedes it rather than orphaning anything.
    await this.mail.sendAdminInvite(
      email,
      rawToken,
      params.inviter?.name ?? 'Mator',
    );
    this.logger.log(`Admin invite issued for ${email} (role=${role})`);
  }

  /**
   * Public preview of a still-valid invite. Missing, expired or already-accepted
   * invites all raise the same 404, so a token cannot be probed for validity
   * against any of those states.
   */
  async preview(rawToken: string): Promise<AdminInvitePreview> {
    const invite = await this.findLiveInvite(rawToken);
    return { email: invite.email, role: invite.role };
  }

  /**
   * Accept an invite: create the admin (email already verified by the invite),
   * mark the invite used, and issue a session exactly as login() does so the
   * panel can log the new admin straight in.
   */
  async accept(
    rawToken: string,
    params: { name: string; password: string },
    context: AdminSessionContext = {},
  ): Promise<IssuedAdminSession> {
    const invite = await this.findLiveInvite(rawToken);

    // Re-check the account does not exist (an admin could have been created for
    // this email between issuing and accepting the invite).
    const clash = await this.prisma.appAdmin.findUnique({
      where: { email: invite.email },
      select: { id: true },
    });
    if (clash) {
      // Burn the now-meaningless invite so the stale link cannot be retried.
      await this.prisma.adminInvite.updateMany({
        where: { id: invite.id, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      throw new ConflictException(
        'An administrator with this email already exists',
      );
    }

    // Claim the invite first (single-use): only one accept can flip acceptedAt
    // from null. A concurrent second accept updates 0 rows and is rejected as
    // "not found", so the same link can never create two accounts.
    const claimed = await this.prisma.adminInvite.updateMany({
      where: { id: invite.id, acceptedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw new NotFoundException('Invite not found');
    }

    // Reuse the SUPER_ADMIN create-admin path: Argon2id hashing + CREATE_ADMIN
    // audit in one transaction. The inviter is carried as the audit actor so the
    // creation is attributed to whoever issued the invite.
    const inviterActor = invite.invitedBy
      ? {
          id: invite.invitedBy.id,
          email: invite.invitedBy.email,
          name: invite.invitedBy.name,
        }
      : null;

    let admin: { id: string; email: string; name: string; role: AdminRole };
    try {
      admin = await this.adminAuth.createAdmin(
        {
          email: invite.email,
          password: params.password,
          name: params.name,
          role: invite.role,
        },
        { actor: inviterActor, actorLabel: inviterActor ? null : 'invite:accept' },
      );
    } catch (err) {
      // Roll the invite back to unaccepted so a transient failure (e.g. DB blip)
      // does not strand a valid invitee with a permanently-burned link.
      await this.prisma.adminInvite
        .updateMany({
          where: { id: invite.id },
          data: { acceptedAt: null },
        })
        .catch(() => undefined);
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'An administrator with this email already exists',
        );
      }
      throw err;
    }

    // Record the acceptance against the freshly-created account (separate from
    // the CREATE_ADMIN entry createAdmin already wrote).
    await this.audit
      .record({
        action: AdminAuditAction.ACCEPT_INVITE,
        actor: { id: admin.id, email: admin.email, name: admin.name },
        target: admin,
        newRole: admin.role,
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `Could not write ACCEPT_INVITE audit for ${admin.id}: ${String(err)}`,
        ),
      );

    this.logger.log(`Admin invite accepted: ${admin.id} (${admin.role})`);

    // Log the new admin straight in — the same session issuance login() uses.
    return this.tokens.issueSession(
      { id: admin.id, role: admin.role, tokenVersion: 0 },
      context,
    );
  }

  /**
   * Look up a live invite by raw token, or throw 404. "Live" = exists, not yet
   * accepted, not expired. All three failure modes collapse to one 404 so a
   * token reveals nothing about which state it is in.
   */
  private async findLiveInvite(rawToken: string) {
    const invite = await this.prisma.adminInvite.findFirst({
      where: { tokenHash: this.hashToken(rawToken) },
      include: {
        invitedBy: { select: { id: true, email: true, name: true } },
      },
    });
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      throw new NotFoundException('Invite not found');
    }
    return invite;
  }
}
