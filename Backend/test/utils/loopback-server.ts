/**
 * Start a test app's HTTP server once, on 127.0.0.1, before supertest uses it.
 *
 * Given a server that is not listening, supertest calls `listen(0)` with no host
 * for EVERY request, which binds the IPv6 wildcard `[::]` on a fresh port, and
 * then sends the request to `127.0.0.1:<port>`. macOS lets that wildcard bind
 * share a port with another process listening on `127.0.0.1:<port>`, and the
 * request goes to that process instead (Claude Code and VS Code helpers answered
 * 401/404 that way). A socket bound to 127.0.0.1 itself cannot share the port,
 * and supertest reuses an already listening server rather than binding again.
 */
import { createServer, type RequestListener, type Server } from 'http';
import type { INestApplication } from '@nestjs/common';

/** A Nest app: listens on 127.0.0.1 and is closed by `app.close()` as usual. */
export async function listenOnLoopback(app: INestApplication): Promise<Server>;
/** A plain handler (an Express app): the caller closes the returned server. */
export async function listenOnLoopback(
  handler: RequestListener,
): Promise<Server>;
export async function listenOnLoopback(
  target: INestApplication | RequestListener,
): Promise<Server> {
  if (typeof target === 'function') {
    const server = createServer(target);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    return server;
  }
  await target.listen(0, '127.0.0.1');
  return target.getHttpServer() as Server;
}

/** Close a server returned for a plain handler. */
export function closeServer(server: Server | undefined): Promise<void> {
  return new Promise((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
}
