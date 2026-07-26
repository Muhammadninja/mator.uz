import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AdminRole, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminAuditContext,
  AdminAuthService,
} from '../auth/admin-auth.service';
import { AdminTokenService } from '../auth/admin-token.service';
import {
  CreateAdminDto,
  ListAdminsQueryDto,
  UpdateAdminDto,
} from './dto/admin-management.dto';

/** Fields exposed by the management API — never passwordHash or tokenVersion. */
const ADMIN_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AppAdminSelect;

/**
 * Administrator management (/v1/admins). A thin, guarded layer over
 * AdminAuthService: every mutation delegates there, so it is audited and
 * revokes sessions by construction rather than by each endpoint remembering to.
 *
 * ── Lockout safety ──
 * The rules below exist so the console cannot be bricked from inside it. An
 * account with no reachable SUPER_ADMIN is unrecoverable without shell access,
 * so removing the last one — by deletion, demotion or deactivation — is refused.
 * Self-targeting is likewise blocked for the destructive actions: an admin
 * deleting or demoting themselves mid-session is almost always a mistake, and
 * the CLI remains the deliberate escape hatch.
 */
@Injectable()
export class AdminManagementService {
  private readonly logger = new Logger(AdminManagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminAuth: AdminAuthService,
    private readonly tokens: AdminTokenService,
  ) {}

  async list(query: ListAdminsQueryDto) {
    const take = Math.min(Math.max(query.take ?? 50, 1), 200);
    const search = query.search?.trim();
    const where: Prisma.AppAdminWhereInput = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { email: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.appAdmin.findMany({
        where,
        select: ADMIN_SELECT,
        orderBy: { createdAt: 'desc' },
        take,
        skip: Math.max(query.skip ?? 0, 0),
      }),
      this.prisma.appAdmin.count({ where }),
    ]);
    return { items, total };
  }

  async getOne(id: string) {
    const admin = await this.prisma.appAdmin.findUnique({
      where: { id },
      select: ADMIN_SELECT,
    });
    if (!admin) throw new NotFoundException('Administrator not found');
    return admin;
  }

  async create(dto: CreateAdminDto, audit: AdminAuditContext) {
    // Checked up front for a clean 409; the unique index is still the real
    // guarantee, so the race is caught below too.
    const existing = await this.prisma.appAdmin.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'An administrator with this email already exists',
      );
    }

    try {
      const created = await this.adminAuth.createAdmin(
        {
          email: dto.email,
          password: dto.password,
          name: dto.name,
          role: dto.role,
        },
        audit,
      );
      return this.getOne(created.id);
    } catch (err) {
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
  }

  /**
   * Update profile fields (name, email). Deliberately cannot change role,
   * password or activation — each of those is a security event with its own
   * audited endpoint, and folding them into a generic PATCH would make it far
   * too easy to grant privileges by accident.
   */
  async update(id: string, dto: UpdateAdminDto, audit: AdminAuditContext) {
    await this.getOne(id);

    if (dto.email) {
      const clash = await this.prisma.appAdmin.findUnique({
        where: { email: dto.email },
        select: { id: true },
      });
      if (clash && clash.id !== id) {
        throw new ConflictException(
          'An administrator with this email already exists',
        );
      }
    }
    if (dto.name === undefined && dto.email === undefined) {
      throw new BadRequestException('Nothing to update');
    }

    await this.prisma.appAdmin.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
      },
    });
    this.logger.log(
      `Admin ${id} profile updated by ${audit.actor?.id ?? 'unknown'}`,
    );
    return this.getOne(id);
  }

  async changeRole(id: string, role: AdminRole, audit: AdminAuditContext) {
    const target = await this.getOne(id);

    if (audit.actor?.id === id && role !== AdminRole.SUPER_ADMIN) {
      // Demoting yourself takes away the very permission needed to undo it.
      throw new BadRequestException('You cannot change your own role');
    }
    if (
      target.role === AdminRole.SUPER_ADMIN &&
      role !== AdminRole.SUPER_ADMIN
    ) {
      await this.assertNotLastSuperAdmin(id, 'demote');
    }

    await this.adminAuth.changeRole(id, role, audit);
    return this.getOne(id);
  }

  async changePassword(id: string, password: string, audit: AdminAuditContext) {
    await this.getOne(id);
    await this.adminAuth.changePassword(id, password, audit);
  }

  async activate(id: string, audit: AdminAuditContext) {
    const target = await this.getOne(id);
    if (target.isActive) return target; // idempotent: nothing to audit.
    await this.adminAuth.reactivate(id, audit);
    return this.getOne(id);
  }

  async deactivate(id: string, audit: AdminAuditContext) {
    const target = await this.getOne(id);

    if (audit.actor?.id === id) {
      // Would immediately invalidate the caller's own session mid-request.
      throw new BadRequestException('You cannot deactivate your own account');
    }
    if (target.role === AdminRole.SUPER_ADMIN) {
      await this.assertNotLastSuperAdmin(id, 'deactivate');
    }
    if (!target.isActive) return target; // idempotent.

    await this.adminAuth.deactivate(id, audit);
    return this.getOne(id);
  }

  async remove(id: string, audit: AdminAuditContext) {
    const target = await this.getOne(id);

    if (audit.actor?.id === id) {
      throw new BadRequestException('You cannot delete your own account');
    }
    if (target.role === AdminRole.SUPER_ADMIN) {
      await this.assertNotLastSuperAdmin(id, 'delete');
    }

    await this.adminAuth.deleteAdmin(id, audit);
  }

  /** Another administrator's active sessions (one entry per signed-in device). */
  async listSessions(adminId: string) {
    await this.getOne(adminId);
    return this.tokens.listSessions(adminId);
  }

  /** End one of another administrator's sessions. */
  async revokeSession(adminId: string, sessionId: number) {
    await this.getOne(adminId);
    const revoked = await this.tokens.revokeSession(adminId, sessionId);
    if (!revoked) throw new NotFoundException('Session not found');
    this.logger.log(`Session ${sessionId} of admin ${adminId} revoked`);
  }

  /**
   * Refuse an action that would leave no ACTIVE SUPER_ADMIN. Counting only
   * active ones matters: a deactivated super admin cannot log in, so leaving
   * one behind is the same as leaving none.
   */
  private async assertNotLastSuperAdmin(
    id: string,
    action: string,
  ): Promise<void> {
    const remaining = await this.prisma.appAdmin.count({
      where: {
        role: AdminRole.SUPER_ADMIN,
        isActive: true,
        id: { not: id },
      },
    });
    if (remaining === 0) {
      throw new BadRequestException(
        `Cannot ${action} the last active SUPER_ADMIN — the console would become unmanageable. ` +
          'Promote another administrator first.',
      );
    }
  }
}
