/**
 * Make a user's search text match literally inside Prisma's `contains`,
 * `startsWith` and `endsWith` (INFO-9).
 *
 * Prisma passes the value into `ILIKE '%' || value || '%'` unescaped (verified
 * against the bundled query compiler: `contains: '50%_off'` becomes the
 * parameter `%50%_off%`), so a `%` or `_` the buyer typed acts as a wildcard:
 * `_` matches any character, and a lone `%` matches every row. PostgreSQL's
 * default LIKE escape character is the backslash, so escaping it and both
 * wildcards keeps the text literal and leaves the query otherwise unchanged.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
