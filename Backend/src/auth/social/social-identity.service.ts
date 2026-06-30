import { Injectable, Logger } from '@nestjs/common';
import { Prisma, Role, type AppUser } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SocialProfile } from './social-profile.interface';

@Injectable()
export class SocialIdentityService {
  private readonly logger = new Logger(SocialIdentityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve a verified social profile to an AppUser, applying account-linking
   * rules. Returns the user row (including passwordHash) for the caller to
   * issue tokens. Idempotent and race-safe via the (provider, providerUserId)
   * unique constraint.
   *
   * Linking rules:
   *   1. Known identity            -> return its user (returning login).
   *   2. New identity + verified   -> link to existing user with same email,
   *      email matching the          or create a fresh user. Auto-links the
   *                                  email/Google/Apple cross-login cases.
   *   3. New identity + UNVERIFIED -> never auto-link by email (takeover
   *      or missing email            prevention); create an isolated user.
   */
  async resolveUser(profile: SocialProfile): Promise<AppUser> {
    // (1) Identity already known -> trusted, immediate login.
    const existing = await this.prisma.authIdentity.findUnique({
      where: {
        provider_providerUserId: {
          provider: profile.provider,
          providerUserId: profile.providerUserId,
        },
      },
      include: { user: true },
    });

    if (existing) {
      await this.refreshIdentityEmail(existing.id, existing.email, profile);
      return existing.user;
    }

    // (2) New identity with a provider-verified email -> safe to link/create.
    if (profile.email && profile.emailVerified) {
      return this.linkOrCreateByEmail(profile);
    }

    // (3) Unverified or absent email (e.g. Apple Hide-My-Email) -> isolated user.
    this.logger.log(
      `Creating isolated account for ${profile.provider}:${profile.providerUserId} (email not verified)`,
    );
    return this.createUserWithIdentity(profile);
  }

  /** Link a new verified identity to an existing email account, or create one. */
  private async linkOrCreateByEmail(profile: SocialProfile): Promise<AppUser> {
    const email = profile.email!;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.appUser.findUnique({ where: { email } });

        if (user) {
          await tx.authIdentity.create({
            data: { ...this.identityData(profile), userId: user.id },
          });
          // The provider asserted a verified email matching this account, so
          // the user demonstrably controls the inbox — mark it verified.
          if (!user.emailVerified) {
            await tx.appUser.update({
              where: { id: user.id },
              data: { emailVerified: true },
            });
            user.emailVerified = true;
          }
          this.logger.log(
            `Linked ${profile.provider} to existing user ${user.id} via verified email`,
          );
          return user;
        }

        const created = await tx.appUser.create({
          data: {
            email,
            passwordHash: null,
            emailVerified: true, // provider-verified email
            firstName: profile.firstName,
            lastName: profile.lastName,
            role: Role.USER,
            identities: { create: this.identityData(profile) },
          },
        });
        this.logger.log(`Created new user ${created.id} from ${profile.provider}`);
        return created;
      });
    } catch (err) {
      // Concurrent request created the same identity/user first; re-resolve.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.warn(`Race on ${profile.provider}:${profile.providerUserId}, re-resolving`);
        return this.resolveUser(profile);
      }
      throw err;
    }
  }

  private async createUserWithIdentity(profile: SocialProfile): Promise<AppUser> {
    try {
      return await this.prisma.appUser.create({
        data: {
          // Synthesize a unique placeholder when no email is supplied.
          email: profile.email ?? this.placeholderEmail(profile),
          passwordHash: null,
          // Social accounts never go through the email/password login path,
          // so they are considered verified by their provider.
          emailVerified: true,
          firstName: profile.firstName,
          lastName: profile.lastName,
          role: Role.USER,
          identities: { create: this.identityData(profile) },
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.resolveUser(profile);
      }
      throw err;
    }
  }

  /** Backfill the identity's email once the provider later reveals a verified one. */
  private async refreshIdentityEmail(
    identityId: number,
    currentEmail: string | null,
    profile: SocialProfile,
  ): Promise<void> {
    if (profile.email && profile.email !== currentEmail) {
      await this.prisma.authIdentity.update({
        where: { id: identityId },
        data: { email: profile.email },
      });
    }
  }

  private identityData(profile: SocialProfile): Prisma.AuthIdentityCreateWithoutUserInput {
    return {
      provider: profile.provider,
      providerUserId: profile.providerUserId,
      email: profile.email,
    };
  }

  private placeholderEmail(profile: SocialProfile): string {
    return `${profile.provider.toLowerCase()}_${profile.providerUserId}@users.noreply.mator.uz`;
  }
}
