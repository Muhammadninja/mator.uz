/**
 * CLI bootstrap for admin-panel accounts (table: app_admins).
 *
 *   npm run admin:create -- --email=admin@example.com --name="Jane Doe" --password='…'
 *   npm run admin:create -- --email=ops@example.com --name="Ops" --role=OPERATOR
 *
 * Each of those is a dry run and writes nothing. Repeat it with `--apply
 * --confirm=<code>` to do it, and `--allow-database=<host/db>` for any non-local
 * database. The code covers the account, not the password. Guarded by
 * src/maintenance/maintenance-guard.ts, because re-running for an existing email
 * resets that account's password.
 *
 * There is no public admin registration endpoint by design, so THIS is how the
 * first SUPER_ADMIN comes into existence; afterwards a SUPER_ADMIN creates the
 * rest. Defaults to SUPER_ADMIN precisely because bootstrapping is its main job.
 *
 * Credentials may also come from the environment (ADMIN_EMAIL / ADMIN_PASSWORD /
 * ADMIN_NAME / ADMIN_ROLE), which is preferable in CI and deploy pipelines: a
 * password passed as a flag lands in the shell history and the process list.
 * When neither a flag nor an env var supplies the password, one is generated and
 * printed once.
 *
 * NOTE: distinct from the SEED_ADMIN_* block in src/prisma/seed.ts, which
 * bootstraps a mobile-side app_users ADMIN. Different table, different login
 * flow; neither affects the other.
 *
 * Re-running for an existing email updates that account (password, name, role,
 * and it is re-activated), so a lost admin password is recoverable. Every
 * existing session of that account is revoked as part of the update.
 */
import 'dotenv/config';
import { AdminAuditAction, AdminRole, PrismaClient } from '@prisma/client';
import { runMaintenance } from '../src/maintenance/maintenance-guard';
import { randomBytes } from 'crypto';
import { CLI_ACTOR_LABEL } from '../src/admin/auth/admin-audit.service';
// Same Argon2id policy as the running app (src/auth/password.util.ts), so a
// CLI-created account and a UI-created one are hashed identically.
import { hashPassword } from '../src/auth/password.util';

const MIN_PASSWORD_LENGTH = 12;

/** Parse `--key=value` / `--key value` pairs out of argv. */
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      args[body.slice(0, eq)] = body.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      // A bare `--flag` with no value is a boolean; only consume the next token
      // when it is not itself a flag.
      args[body] = next && !next.startsWith('--') ? (i++, next) : 'true';
    }
  }
  return args;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function readAccount(args: Record<string, string>, env: NodeJS.ProcessEnv) {
  const email = (args.email ?? env.ADMIN_EMAIL ?? '')
    .trim()
    .toLowerCase();
  const name = (args.name ?? env.ADMIN_NAME ?? '').trim();
  const roleInput = (
    args.role ??
    env.ADMIN_ROLE ??
    AdminRole.SUPER_ADMIN
  )
    .toString()
    .trim()
    .toUpperCase();

  if (!email || !isValidEmail(email)) {
    throw new Error('A valid --email (or ADMIN_EMAIL) is required.');
  }
  if (!name) {
    throw new Error('A --name (or ADMIN_NAME) is required.');
  }
  if (!Object.values(AdminRole).includes(roleInput as AdminRole)) {
    throw new Error(
      `Invalid role "${roleInput}". Expected one of: ${Object.values(AdminRole).join(', ')}.`,
    );
  }
  return { email, name, role: roleInput as AdminRole };
}

async function applyAdmin(
  prisma: PrismaClient,
  args: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const { email, name, role } = readAccount(args, env);

  // Generate when unsupplied, so the operator is never nudged into inventing a
  // weak bootstrap password.
  const supplied = args.password ?? env.ADMIN_PASSWORD;
  const generated = !supplied;
  const password = supplied ?? randomBytes(18).toString('base64url');

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  // Argon2id has no truncation limit, but AdminLoginDto caps the password at 72
  // characters — so a longer one here would create an account whose password can
  // never be submitted at login. Kept in sync deliberately.
  if (password.length > 72) {
    throw new Error(
      'Password must be at most 72 characters (the login limit).',
    );
  }

  const passwordHash = await hashPassword(password);
  const existing = await prisma.appAdmin.findUnique({
    where: { email },
    select: { id: true },
  });

  const admin = await prisma.appAdmin.upsert({
    where: { email },
    // Re-activate on update: this script is also the "I locked myself out" path.
    // Bumping tokenVersion revokes every access token issued under the old
    // password; the refresh rows are deleted below.
    update: {
      passwordHash,
      name,
      role,
      isActive: true,
      tokenVersion: { increment: 1 },
    },
    create: { email, passwordHash, name, role },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      createdAt: true,
    },
  });

  // Audited like any other admin-lifecycle change, with no actor: this runs
  // from a shell, not from a signed-in session. `actorLabel` records that
  // origin so the entry never looks like an anonymous mystery write.
  await prisma.adminAudit.create({
    data: {
      action: existing
        ? AdminAuditAction.RESET_PASSWORD
        : AdminAuditAction.CREATE_ADMIN,
      actorLabel: CLI_ACTOR_LABEL,
      targetAdminId: admin.id,
      targetEmail: admin.email,
      targetName: admin.name,
      newRole: admin.role,
    },
  });

  if (existing) {
    await prisma.adminRefreshToken.deleteMany({ where: { adminId: admin.id } });
  }

  console.log(existing ? '\n✔ Admin updated' : '\n✔ Admin created');
  console.table({
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    isActive: admin.isActive,
  });
  if (existing) {
    console.log(
      '  (existing account — password reset and all previous sessions revoked)',
    );
  }
  if (generated) {
    // Printed exactly once: only the bcrypt hash is persisted, so this value is
    // unrecoverable afterwards.
    console.log(`\n  Generated password: ${password}`);
    console.log(
      '  Store it now — it is not saved anywhere and cannot be shown again.\n',
    );
  }
}

export function runCreateAdmin(
  prisma: PrismaClient,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  const args = parseArgs([...argv]);
  return runMaintenance({
    script: 'admin:create',
    argv,
    env,
    buildPlan: async () => {
      const { email, name, role } = readAccount(args, env);
      const existing = await prisma.appAdmin.findUnique({
        where: { email },
        select: { id: true },
      });
      return {
        summary: [
          existing
            ? `${email} EXISTS: its password is reset and its sessions revoked`
            : `${email} would be created`,
        ],
        items: [{ email, name, role, existing: !!existing }],
      };
    },
    apply: () => applyAdmin(prisma, args, env),
  });
}

if (require.main === module) {
  const prisma = new PrismaClient();
  runCreateAdmin(prisma, process.argv.slice(2), process.env)
    .then(async () => {
      await prisma.$disconnect();
    })
    .catch(async (e: unknown) => {
      console.error(`\n✖ ${e instanceof Error ? e.message : String(e)}\n`);
      await prisma.$disconnect();
      // Non-zero exit so a failed bootstrap cannot be mistaken for success in a
      // `migrate deploy && admin:create` pipeline.
      process.exit(1);
    });
}
