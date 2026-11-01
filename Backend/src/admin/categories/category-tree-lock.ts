import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** A reassignment can touch thousands of parts; Prisma's default is 5 seconds. */
const TREE_WRITE_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

/**
 * Run a structural write to the category tree in one transaction, serialized
 * against every other. The rules that keep it a tree (no cycle, the depth cap,
 * unique slugs, a parent that exists) are read-then-write checks over several rows,
 * so row locks cannot protect them: two opposite moves each pass the cycle check
 * against a tree the other has not changed yet, and commit a cycle whose nodes then
 * vanish from every listing. Taxonomy edits are rare and quick, so a single queue
 * costs nothing.
 *
 * The key is a literal rather than a parameter, so the statement is the same text
 * through any pooler. It is arbitrary, but this is the only advisory lock in the
 * application, so it cannot collide.
 */
export function writeCategoryTree<T>(
  prisma: PrismaService,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return translateCategoryDbErrors(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(73100001)`;
      return write(tx);
    }, TREE_WRITE_OPTIONS),
  );
}

/**
 * Answer the database's own refusals in HTTP terms. The checks in the services make
 * these rare, but a writer outside them (a seed, the bot) can still get there first,
 * and the operator is owed a 4xx rather than an opaque 500.
 */
export async function translateCategoryDbErrors<T>(
  op: () => Promise<T>,
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') {
        throw new ConflictException('This slug is already in use');
      }
      if (err.code === 'P2003') {
        throw new ConflictException(
          'The category is referenced by other records — reload and try again',
        );
      }
      if (err.code === 'P2025') {
        throw new NotFoundException('Category not found');
      }
      if (err.code === 'P2028' || err.code === 'P2034') {
        throw new ConflictException(
          'The category tree is busy or changed meanwhile — try again',
        );
      }
    }
    throw err;
  }
}
