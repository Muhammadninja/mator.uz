import {
  Injectable,
  Logger,
  BadRequestException,
  GoneException,
} from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { type AppUser } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESEND_COOLDOWN_MS = 60 * 1000; // 60s between emails per user

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  private hash(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  /**
   * Generate a new verification token for a user, invalidating any prior
   * outstanding tokens, persist only its hash, and email the raw value.
   *
   * Soft-consume strategy: previously-issued, still-active tokens are marked
   * consumed (consumedAt set) rather than deleted, so exactly one token is
   * ever valid while the full history is retained for auditability.
   */
  async issueAndSend(user: Pick<AppUser, 'id' | 'email'>): Promise<void> {
    const rawToken = randomBytes(32).toString('hex'); // 256-bit, URL-safe hex
    const tokenHash = this.hash(rawToken);
    const now = new Date();

    await this.prisma.$transaction([
      // Invalidate (do NOT delete) any prior active tokens for this user.
      this.prisma.emailVerificationToken.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: now },
      }),
      this.prisma.emailVerificationToken.create({
        data: { tokenHash, userId: user.id, expiresAt: new Date(now.getTime() + TOKEN_TTL_MS) },
      }),
    ]);

    await this.mail.sendVerificationEmail(user.email, rawToken);
    this.logger.log(`Verification email issued for user ${user.id}`);
  }

  /** Validate a raw token, mark the user verified, and soft-consume the token. */
  async verify(rawToken: string): Promise<void> {
    const tokenHash = this.hash(rawToken);
    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    // Generic message — never reveal whether a token existed (anti-enumeration).
    // consumedAt != null => already used (single-use enforced).
    if (!record || record.consumedAt) {
      throw new BadRequestException('Invalid or already-used verification link');
    }
    if (record.expiresAt < new Date()) {
      throw new GoneException('Verification link has expired. Please request a new one.');
    }

    await this.prisma.$transaction([
      this.prisma.appUser.update({
        where: { id: record.userId },
        data: { emailVerified: true },
      }),
      // Soft-consume: stamp consumedAt; keep the row for the audit trail.
      this.prisma.emailVerificationToken.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      }),
    ]);

    this.logger.log(`Email verified for user ${record.userId}`);
  }

  /**
   * Resend flow. Always returns silently (anti-enumeration): the caller cannot
   * distinguish "no such user", "already verified", or "email sent".
   */
  async resend(email: string): Promise<void> {
    const user = await this.prisma.appUser.findUnique({ where: { email } });
    if (!user || user.emailVerified) {
      this.logger.debug(`Resend ignored for ${email} (missing or already verified)`);
      return;
    }

    // Per-user cooldown to prevent mailbox flooding even within rate limits.
    const latest = await this.prisma.emailVerificationToken.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    if (latest && Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      this.logger.warn(`Resend throttled for user ${user.id} (cooldown)`);
      return; // silent — same response shape as success
    }

    await this.issueAndSend(user);
  }
}
