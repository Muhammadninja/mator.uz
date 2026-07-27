import { Injectable, Logger } from '@nestjs/common';
import {
  AdminAuditAction,
  AdminAuditEntity,
  AdminRole,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { getRequestId } from '../../common/request-context';

/** Who performed an audited action. */
export interface AdminAuditActor {
  id: string;
  email: string;
  name: string;
}

/**
 * Target of an action performed on something that is NOT an administrator
 * account — today a dealer. Written to targetEntity/targetEntityId, never to
 * targetAdminId: that column is an FK to app_admins and a dealer id would
 * violate it. `name` is snapshotted into targetName, exactly as for admin
 * targets, so the entry stays readable after the dealer is renamed or removed.
 */
export interface AdminAuditEntityTarget {
  entity: AdminAuditEntity;
  id: string;
  name: string;
}

/**
 * Origin label for actions with no signed-in administrator — today only the CLI
 * bootstrap of the very first SUPER_ADMIN, which by definition has no actor.
 */
export const CLI_ACTOR_LABEL = 'cli:admin:create';

export interface AdminAuditEntry {
  action: AdminAuditAction;
  /** Null for actions with no signed-in actor; pass `actorLabel` instead. */
  actor?: AdminAuditActor | null;
  actorLabel?: string | null;
  /**
   * What the action was performed on. An administrator account (the original
   * shape, written to the targetAdminId FK) or another kind of entity such as a
   * dealer (written to targetEntity/targetEntityId).
   */
  target: { id: string; email: string; name: string } | AdminAuditEntityTarget;
  /** Only for CHANGE_ROLE. */
  previousRole?: AdminRole | null;
  newRole?: AdminRole | null;
  /**
   * Before/after snapshot of ONLY the fields the action changed — never a whole
   * row, and never a credential. Used by the dealer console so an entry shows
   * what actually flipped, e.g. {certified: false} → {certified: true}.
   */
  previousValues?: Prisma.InputJsonValue | null;
  newValues?: Prisma.InputJsonValue | null;
  /** Free-text reason from the acting admin (e.g. dealer suspension). */
  reason?: string | null;
  /** Untrusted request provenance — display-only. */
  ip?: string | null;
  userAgent?: string | null;
  /**
   * Correlation id of the originating HTTP request. Normally omitted: it is
   * read from the ambient request context, so no caller has to remember to pass
   * it. Supply it only to override (e.g. replaying an action out-of-band).
   */
  requestId?: string | null;
}

/**
 * Append-only audit trail for critical administrator actions.
 *
 * Two rules make the trail worth trusting:
 *
 *   1. WRITE IN THE CALLER'S TRANSACTION. Every method takes an optional `tx`,
 *      and the mutating services pass one. The change and its audit entry then
 *      commit together — a deactivation can never succeed while its audit row
 *      silently fails, and a rolled-back change leaves no misleading entry.
 *      This is deliberately NOT the best-effort treatment `lastLoginAt` gets:
 *      losing a login timestamp is cosmetic, losing an audit record is not.
 *
 *   2. SNAPSHOT BOTH IDENTITIES. Email and name are copied in at write time, so
 *      an entry stays readable after either account is renamed or deleted (the
 *      FKs are ON DELETE SET NULL, never CASCADE).
 *
 * Nothing here writes a password, a hash, or a token — CHANGE_PASSWORD records
 * only that it happened, never any part of the credential.
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Run against the caller's transaction when supplied, else the client. */
  private db(tx?: Prisma.TransactionClient): Prisma.TransactionClient {
    return tx ?? this.prisma;
  }

  /**
   * Record one audited action. Pass `tx` so the entry commits atomically with
   * the change it describes.
   */
  async record(
    entry: AdminAuditEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    // An admin-account target fills the targetAdminId FK; any other entity
    // fills targetEntity/targetEntityId instead. Both snapshot targetName.
    const target = isEntityTarget(entry.target)
      ? {
          targetAdminId: null,
          targetEmail: null,
          targetName: entry.target.name,
          targetEntity: entry.target.entity,
          targetEntityId: entry.target.id,
        }
      : {
          targetAdminId: entry.target.id,
          targetEmail: entry.target.email,
          targetName: entry.target.name,
          targetEntity: null,
          targetEntityId: null,
        };

    await this.db(tx).adminAudit.create({
      data: {
        action: entry.action,
        actorId: entry.actor?.id ?? null,
        actorEmail: entry.actor?.email ?? null,
        actorName: entry.actor?.name ?? null,
        actorLabel: entry.actorLabel ?? null,
        ...target,
        previousRole: entry.previousRole ?? null,
        newRole: entry.newRole ?? null,
        previousValues: entry.previousValues ?? Prisma.DbNull,
        newValues: entry.newValues ?? Prisma.DbNull,
        reason: truncate(entry.reason, 500),
        ip: truncate(entry.ip, 45),
        userAgent: truncate(entry.userAgent, 400),
        // Taken from the ambient context when not given explicitly, so every
        // action performed over HTTP is correlatable without the call sites
        // having to thread it through.
        requestId: truncate(entry.requestId ?? getRequestId(), 64),
      },
    });
    // The same id is prefixed onto this line, so grepping it returns the HTTP
    // request, any exception, and this audit write together.
    const requestId = entry.requestId ?? getRequestId();
    this.logger.log(
      `${requestId ? `[${requestId}] ` : ''}[audit] ${entry.action} ` +
        `target=${entry.target.id} ` +
        `actor=${entry.actor?.id ?? entry.actorLabel ?? 'unknown'}`,
    );
  }

  /**
   * The audit trail, newest first — for the admin console's "activity" view.
   * Filterable by target or actor; both use a covering index.
   */
  async list(params: {
    targetAdminId?: string;
    /** Non-admin target, e.g. everything that happened to one dealer. */
    targetEntity?: AdminAuditEntity;
    targetEntityId?: string;
    actorId?: string;
    action?: AdminAuditAction;
    take?: number;
    skip?: number;
  }) {
    const take = Math.min(Math.max(params.take ?? 50, 1), 200);
    const where: Prisma.AdminAuditWhereInput = {
      ...(params.targetAdminId ? { targetAdminId: params.targetAdminId } : {}),
      ...(params.targetEntity ? { targetEntity: params.targetEntity } : {}),
      ...(params.targetEntityId
        ? { targetEntityId: params.targetEntityId }
        : {}),
      ...(params.actorId ? { actorId: params.actorId } : {}),
      ...(params.action ? { action: params.action } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.adminAudit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip: Math.max(params.skip ?? 0, 0),
      }),
      this.prisma.adminAudit.count({ where }),
    ]);
    return { items, total };
  }
}

/** Narrow the target union: an entity target is the one carrying `entity`. */
function isEntityTarget(
  target: AdminAuditEntry['target'],
): target is AdminAuditEntityTarget {
  return 'entity' in target;
}

/** Clamp untrusted metadata to its column width; blank/absent becomes null. */
function truncate(
  value: string | null | undefined,
  max: number,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}
