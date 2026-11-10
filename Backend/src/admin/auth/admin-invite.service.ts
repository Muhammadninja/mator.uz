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

/** Upper bound on the pending list; invites are issued at most 10 an hour. */
const MAX_PENDING_LISTED = 200;

/** A pending invite as shown to a SUPER_ADMIN. Carries no token material. */
export interface PendingAdminInvite {
  id: string;
  email: string;
  role: AdminRole;
  expiresAt: Date;
  createdAt: Date;
  invitedBy: { id: string; email: string; name: string } | null;
}

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
 *   • Missing/expired/accepted/revoked all collapse to 404, so a token cannot
 *     be probed.
 *   • Bound to its issuer: an invite is honoured only while the administrator
 *     who issued it is active and still a SUPER_ADMIN. Deactivating, demoting
 *     or deleting them drops their pending invites (AdminAuthService), and
 *     acceptance re-checks under a row lock.
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
    // A cheap refusal for a dead link before paying for the password hash. The
    // decision that counts is taken again below, under row locks.
    await this.findLiveInvite(rawToken);
    const tokenHash = this.hashToken(rawToken);

    // One transaction decides everything: the invite is still unused, its
    // issuer is still an active SUPER_ADMIN, and the account does not exist.
    // The invite row is locked, so a second accept of the same link waits and
    // then finds it used. The issuer's row is share-locked, so a deactivation or
    // demotion either commits first (and this accept is refused) or waits until
    // the account exists (and then finds no pending invite left to drop).
    const outcome = await this.prisma.$transaction(async (tx) => {
      const [invite] = await tx.$queryRaw<
        {
          id: string;
          email: string;
          role: AdminRole;
          invited_by_id: string | null;
          expires_at: Date;
          accepted_at: Date | null;
        }[]
      >`
        SELECT id, email, role, invited_by_id, expires_at, accepted_at
        FROM admin_invites WHERE token_hash = ${tokenHash}
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
      if (!invite || invite.accepted_at || invite.expires_at < new Date()) {
        throw new NotFoundException('Invite not found');
      }

      const [inviter] = invite.invited_by_id
        ? await tx.$queryRaw<
            {
              id: string;
              email: string;
              name: string;
              role: AdminRole;
              is_active: boolean;
            }[]
          >`
            SELECT id, email, name, role, is_active FROM app_admins
            WHERE id = ${invite.invited_by_id} FOR SHARE`
        : [];
      if (
        !inviter ||
        !inviter.is_active ||
        inviter.role !== AdminRole.SUPER_ADMIN
      ) {
        // The issuer was deleted, deactivated or demoted since. The invite is
        // void; removed so the link stays dead even if they are reinstated.
        await tx.adminInvite.delete({ where: { id: invite.id } });
        this.logger.warn(
          `Invite ${invite.id} refused: its issuer no longer holds the authority to invite`,
        );
        return { refused: 'not_found' as const };
      }

      const clash = await tx.appAdmin.findUnique({
        where: { email: invite.email },
        select: { id: true },
      });
      if (clash) {
        // Burn the now-meaningless invite so the stale link cannot be retried.
        await tx.adminInvite.update({
          where: { id: invite.id },
          data: { acceptedAt: new Date() },
        });
        return { refused: 'conflict' as const };
      }

      await tx.adminInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });
      // The SUPER_ADMIN create-admin path: Argon2id hashing + CREATE_ADMIN
      // audit, attributed to whoever issued the invite. A failure here rolls
      // the claim back with it, so a transient error never burns the link.
      const admin = await this.adminAuth.createAdmin(
        {
          email: invite.email,
          password: params.password,
          name: params.name,
          role: invite.role,
        },
        { actor: { id: inviter.id, email: inviter.email, name: inviter.name } },
        tx,
      );
      await this.audit.record(
        {
          action: AdminAuditAction.ACCEPT_INVITE,
          actor: { id: admin.id, email: admin.email, name: admin.name },
          target: admin,
          newRole: admin.role,
        },
        tx,
      );
      return { admin };
    }).catch((err: unknown) => {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'An administrator with this email already exists',
        );
      }
      throw err;
    });

    // Thrown after the transaction so the cleanup writes above commit.
    if ('refused' in outcome) {
      if (outcome.refused === 'conflict') {
        throw new ConflictException(
          'An administrator with this email already exists',
        );
      }
      throw new NotFoundException('Invite not found');
    }
    const { admin } = outcome;
    this.logger.log(`Admin invite accepted: ${admin.id} (${admin.role})`);

    // Log the new admin straight in — the same session issuance login() uses.
    return this.tokens.issueSession(
      { id: admin.id, role: admin.role, tokenVersion: 0 },
      context,
    );
  }

  /**
   * Invites still waiting to be accepted, newest first. Never the token or its
   * hash: the list is for review, and the hash is the invite's only stored form.
   */
  async listPending(): Promise<PendingAdminInvite[]> {
    const rows = await this.prisma.adminInvite.findMany({
      where: { acceptedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true,
        createdAt: true,
        invitedBy: { select: { id: true, email: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_PENDING_LISTED,
    });
    return rows;
  }

  /**
   * Revoke a pending invite: its link stops working at once. The row is
   * deleted, so a revoked invite answers exactly like one that never existed.
   *
   * @throws NotFoundException when there is no such pending invite.
   */
  async revoke(inviteId: string, audit: AdminAuditContext): Promise<void> {
    const dropped = await this.prisma.adminInvite.deleteMany({
      where: { id: inviteId, acceptedAt: null },
    });
    if (dropped.count === 0) throw new NotFoundException('Invite not found');
    // No AdminAudit row: the enum has no value for revoking an invite, and
    // writing it under another action would falsify the trail.
    this.logger.log(
      `Admin invite ${inviteId} revoked by ${audit.actor?.id ?? 'unknown'}`,
    );
  }

  /**
   * Look up a live invite by raw token, or throw 404. "Live" = exists, not yet
   * accepted, not expired, and issued by someone who may still invite. Every
   * failure mode collapses to one 404 so a token reveals nothing about which
   * state it is in.
   */
  private async findLiveInvite(rawToken: string) {
    const invite = await this.prisma.adminInvite.findFirst({
      where: { tokenHash: this.hashToken(rawToken) },
      include: {
        invitedBy: {
          select: { id: true, email: true, name: true, role: true, isActive: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (
      !invite ||
      invite.acceptedAt ||
      invite.expiresAt < new Date() ||
      !invite.invitedBy?.isActive ||
      invite.invitedBy.role !== AdminRole.SUPER_ADMIN
    ) {
      throw new NotFoundException('Invite not found');
    }
    return invite;
  }
}
