import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LegalAcceptance, LegalDocument, LegalDocumentType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppLang, DEFAULT_APP_LANG, parseAppLang } from '../common/app-lang.util';
import {
  LegalDocumentResponse,
  LegalStatusItemResponse,
  LegalStatusResponse,
  presentLegalDocument,
} from './legal.presenter';

/**
 * The documents a user MUST consent to. Deriving the required set from this
 * constant rather than from "whatever rows happen to be active" is deliberate:
 * if a locale is missing its PRIVACY_POLICY row, that is a seeding failure that
 * must surface, not a silent reduction of what consent means.
 */
export const REQUIRED_LEGAL_DOCUMENT_TYPES: readonly LegalDocumentType[] = [
  LegalDocumentType.TERMS_OF_USE,
  LegalDocumentType.PRIVACY_POLICY,
  LegalDocumentType.PERSONAL_DATA_CONSENT,
] as const;

/** Machine-readable code the client switches on (see HttpExceptionFilter). */
export const LEGAL_ACCEPTANCE_REQUIRED = 'LEGAL_ACCEPTANCE_REQUIRED';

/** Request provenance captured server-side; never supplied by the client. */
export interface LegalAcceptanceContext {
  ipAddress?: string | null;
  userAgent?: string | null;
  locale?: string | null;
}

/** A claimed acceptance as it arrives from a client. */
export interface ClaimedAcceptance {
  type: LegalDocumentType;
  version: number;
}

/** Prisma client or an interactive transaction — both satisfy the reads below. */
type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class LegalService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Reads ───────────────────────────────────────────────────────────────────

  /**
   * The currently required documents, rendered in the best available language.
   *
   * Never returns a partial set: a document with no row in ANY locale is a
   * misconfiguration (the seed did not run), and answering with two of three
   * documents would let a client collect consent that is legally incomplete.
   */
  async listCurrentDocuments(lang: AppLang): Promise<LegalDocumentResponse[]> {
    const documents = await Promise.all(
      REQUIRED_LEGAL_DOCUMENT_TYPES.map((type) =>
        this.resolveActiveDocument(this.prisma, type, lang),
      ),
    );
    return documents.map((doc) => presentLegalDocument(doc, true));
  }

  /** One specific historical version, for audit/history screens. */
  async getDocumentVersion(
    type: LegalDocumentType,
    version: number,
    lang: AppLang,
  ): Promise<LegalDocumentResponse> {
    // Same fallback ladder as the current-document lookup, but pinned to one
    // version: a user reviewing what they accepted should see it in their own
    // language when that translation exists.
    const doc =
      (await this.prisma.legalDocument.findUnique({
        where: { type_version_locale: { type, version, locale: lang } },
      })) ??
      (lang === DEFAULT_APP_LANG
        ? null
        : await this.prisma.legalDocument.findUnique({
            where: {
              type_version_locale: { type, version, locale: DEFAULT_APP_LANG },
            },
          })) ??
      // Last resort: any locale this version exists in. Showing the document in
      // the wrong language beats telling a user their own consent record does
      // not exist.
      (await this.prisma.legalDocument.findFirst({
        where: { type, version },
        orderBy: { locale: 'asc' },
      }));

    const active = await this.findActiveVersion(this.prisma, type);

    // This endpoint is PUBLIC, so it may serve only text that has actually been
    // published: the version in force, or one it superseded. A row that is
    // inactive and NEWER than the active version is an unpublished draft (the
    // create-version → publish workflow this model is built for), and handing
    // that to anonymous callers would leak wording before it takes legal effect.
    // Reported as 404 rather than 403 — the existence of a draft is itself not
    // public information.
    const isPublished =
      doc !== null && active !== null && (doc.isActive || doc.version < active);

    if (!doc || !isPublished) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: `No ${type} document at version ${version}.`,
      });
    }
    // A superseded version is still served — that is the entire point of this
    // endpoint — but `is_required` reflects whether it is the version in force.
    return presentLegalDocument(doc, active === doc.version);
  }

  /**
   * What the user still has to accept.
   *
   * `accepted_at` reports the user's LATEST acceptance of the document even when
   * that acceptance is of a superseded version, so a client can show "you agreed
   * to v1 on <date>; here is v2" rather than a bare "not accepted".
   */
  async getStatus(userId: string, lang: AppLang): Promise<LegalStatusResponse> {
    const required = await Promise.all(
      REQUIRED_LEGAL_DOCUMENT_TYPES.map(async (type) => ({
        type,
        document: await this.resolveActiveDocument(this.prisma, type, lang),
      })),
    );

    const latest = await this.latestAcceptancesByType(this.prisma, userId);

    const documents: LegalStatusItemResponse[] = required.map(({ type, document }) => {
      const acceptance = latest.get(type) ?? null;
      // Compared with >=, not ===: a user who accepted v3 is not un-consented by
      // a rollback that re-activates v2. Only a version they never reached
      // requires action.
      const accepted =
        acceptance !== null && acceptance.documentVersion >= document.version;
      return {
        type,
        required_version: document.version,
        accepted_version: acceptance?.documentVersion ?? null,
        accepted,
        ...(acceptance
          ? { accepted_at: acceptance.acceptedAt.toISOString() }
          : {}),
      };
    });

    return {
      requires_acceptance: documents.some((d) => !d.accepted),
      documents,
    };
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  /**
   * Record consent to every required document, atomically.
   *
   * Validation and insertion share one transaction, so a request that names a
   * stale version for its third document leaves NO acceptance rows behind for
   * the first two — a half-consented user is not a state this system can reach.
   */
  async accept(
    userId: string,
    claimed: ClaimedAcceptance[],
    context: LegalAcceptanceContext,
  ): Promise<LegalStatusResponse> {
    // Parsed, not cast: `context.locale` is a plain string on the interface, so
    // asserting it were an AppLang would let a future caller smuggle an
    // unsupported code into the document lookup.
    const lang = parseAppLang(context.locale) ?? DEFAULT_APP_LANG;

    await this.prisma.$transaction(async (tx) => {
      const documents = await this.validateClaims(tx, claimed, lang);
      await this.recordAcceptances(tx, userId, documents, context);
    });

    return this.getStatus(userId, lang);
  }

  /**
   * Registration-time consent, inside the caller's transaction.
   *
   * Exposed separately from {@link accept} so account creation and consent
   * commit or fail together: a new account must never exist without the consent
   * it was created under, and consent must never be recorded for an account
   * whose creation rolled back.
   */
  async acceptWithinTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    claimed: ClaimedAcceptance[],
    context: LegalAcceptanceContext,
  ): Promise<void> {
    // Parsed, not cast: `context.locale` is a plain string on the interface, so
    // asserting it were an AppLang would let a future caller smuggle an
    // unsupported code into the document lookup.
    const lang = parseAppLang(context.locale) ?? DEFAULT_APP_LANG;
    const documents = await this.validateClaims(tx, claimed, lang);
    await this.recordAcceptances(tx, userId, documents, context);
  }

  /**
   * Whether the user has accepted the current version of every required
   * document. Used by the registration gate; cheaper than building the full
   * status payload when only the boolean matters.
   */
  async hasAcceptedAllRequired(userId: string): Promise<boolean> {
    const required = await Promise.all(
      REQUIRED_LEGAL_DOCUMENT_TYPES.map(async (type) => ({
        type,
        version: await this.findActiveVersion(this.prisma, type),
      })),
    );
    const latest = await this.latestAcceptancesByType(this.prisma, userId);
    return required.every(({ type, version }) => {
      if (version === null) return true; // Nothing published => nothing to accept.
      const acceptance = latest.get(type);
      return acceptance !== undefined && acceptance.documentVersion >= version;
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /**
   * Check every claimed acceptance against the DB and return the document rows
   * to write.
   *
   * The client's `version` is treated as an assertion about what it displayed,
   * never as the answer: the required version comes from the active row. This is
   * what stops a client from consenting on a user's behalf to a version that is
   * no longer in force (or has not been shown to them).
   */
  private async validateClaims(
    db: Db,
    claimed: ClaimedAcceptance[],
    lang: AppLang,
  ): Promise<LegalDocument[]> {
    // The DTO already rejects duplicates; re-checked here because this method is
    // also reachable from the registration path, whose input is shaped
    // differently.
    const seen = new Set<LegalDocumentType>();
    for (const item of claimed) {
      if (seen.has(item.type)) {
        throw new BadRequestException({
          code: LEGAL_ACCEPTANCE_REQUIRED,
          message: `Duplicate acceptance for ${item.type}.`,
        });
      }
      seen.add(item.type);
    }

    const missing = REQUIRED_LEGAL_DOCUMENT_TYPES.filter((t) => !seen.has(t));
    if (missing.length > 0) {
      throw new BadRequestException({
        code: LEGAL_ACCEPTANCE_REQUIRED,
        message: `Required legal documents must be accepted: ${missing.join(', ')}.`,
      });
    }

    const resolved: LegalDocument[] = [];
    for (const item of claimed) {
      // Throws when the type is required but has no active row anywhere — a
      // seeding failure, which must not be reported as the user's problem.
      const active = await this.resolveActiveDocument(db, item.type, lang);
      if (item.version !== active.version) {
        throw new BadRequestException({
          code: LEGAL_ACCEPTANCE_REQUIRED,
          message:
            `${item.type} must be accepted at version ${active.version}, ` +
            `but version ${item.version} was submitted.`,
        });
      }
      resolved.push(active);
    }
    return resolved;
  }

  /**
   * Insert the acceptance rows, skipping versions the user has already accepted.
   *
   * Idempotent by INTENT, not by constraint: a retried submit must not stack
   * duplicate evidence for the same version, but the table stays append-only so
   * a genuine v1 → v2 transition always adds a row. The check and the insert
   * share the caller's transaction, so two concurrent submits cannot both pass.
   */
  private async recordAcceptances(
    db: Db,
    userId: string,
    documents: LegalDocument[],
    context: LegalAcceptanceContext,
  ): Promise<void> {
    // Deduplicated on (document TYPE, version) — NOT on documentId. Each locale
    // is its own row, so `documentId` would treat "accepted the Terms v1 in ru"
    // and "…in en" as two different consents and stack a second row for the same
    // instrument. What a user consents to is the DOCUMENT AT A VERSION; the
    // language it was displayed in is provenance (recorded in `locale`), not
    // part of the thing being agreed to.
    const existing = await db.legalAcceptance.findMany({
      where: { userId, document: { type: { in: documents.map((d) => d.type) } } },
      select: { documentVersion: true, document: { select: { type: true } } },
    });
    const already = new Set(
      existing.map((e) => `${e.document.type}|${e.documentVersion}`),
    );

    const rows = documents
      .filter((doc) => !already.has(`${doc.type}|${doc.version}`))
      .map((doc) => ({
        userId,
        documentId: doc.id,
        documentVersion: doc.version,
        // Truncated to the column widths so an oversized proxy header or a
        // pathological User-Agent cannot fail the write.
        ipAddress: truncate(context.ipAddress, 45),
        userAgent: truncate(context.userAgent, 500),
        locale: truncate(context.locale, 8),
      }));

    if (rows.length > 0) {
      await db.legalAcceptance.createMany({ data: rows });
    }
  }

  /**
   * The active document for `type`, in the best available language.
   *
   * The single place the locale fallback lives, so every endpoint answers the
   * same way: requested language → project default (`ru`) → any locale that has
   * it. A missing translation must not read as a missing document.
   */
  private async resolveActiveDocument(
    db: Db,
    type: LegalDocumentType,
    lang: AppLang,
  ): Promise<LegalDocument> {
    const doc =
      (await db.legalDocument.findFirst({
        where: { type, locale: lang, isActive: true },
      })) ??
      (lang === DEFAULT_APP_LANG
        ? null
        : await db.legalDocument.findFirst({
            where: { type, locale: DEFAULT_APP_LANG, isActive: true },
          })) ??
      (await db.legalDocument.findFirst({
        where: { type, isActive: true },
        orderBy: { locale: 'asc' },
      }));

    if (!doc) {
      // A required document with no active version in any language is a server
      // misconfiguration (unseeded environment), not a client error — hence 500
      // via the default filter rather than a 4xx blaming the caller.
      throw new Error(
        `No active ${type} legal document is published (locale: ${lang}). ` +
          'Run the legal document seed.',
      );
    }
    return doc;
  }

  /** The active version number for `type`, or null when none is published. */
  private async findActiveVersion(
    db: Db,
    type: LegalDocumentType,
  ): Promise<number | null> {
    const doc = await db.legalDocument.findFirst({
      where: { type, isActive: true },
      select: { version: true },
      orderBy: { version: 'desc' },
    });
    return doc?.version ?? null;
  }

  /**
   * The user's highest-versioned acceptance per document type.
   *
   * Ordered by version (not time) because version is what the comparison against
   * the required version is made on; `acceptedAt` then reports when that version
   * was accepted, which is the date a client should display.
   */
  private async latestAcceptancesByType(
    db: Db,
    userId: string,
  ): Promise<Map<LegalDocumentType, LegalAcceptance & { document: LegalDocument }>> {
    const acceptances = await db.legalAcceptance.findMany({
      where: { userId },
      include: { document: true },
      orderBy: [{ documentVersion: 'asc' }, { acceptedAt: 'asc' }],
    });
    // Ascending order means the last write per type wins — the highest version,
    // and among equal versions the most recent acceptance.
    const byType = new Map<
      LegalDocumentType,
      LegalAcceptance & { document: LegalDocument }
    >();
    for (const acceptance of acceptances) {
      byType.set(acceptance.document.type, acceptance);
    }
    return byType;
  }
}

/** Clip a value to a column width; null/undefined and blanks stay null. */
function truncate(value: string | null | undefined, max: number): string | null {
  const v = value?.trim();
  return v ? v.slice(0, max) : null;
}
