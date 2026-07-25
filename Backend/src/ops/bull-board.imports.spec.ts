/**
 * Bull Board mounting + auth wiring.
 *
 * `bullBoardImports()` reads process.env at CALL time, so each case just sets
 * the env around the call.
 *
 * The critical assertion here is that the auth middleware is actually attached
 * to the board's options. `BullBoardModuleOptions.middleware` is typed `any`
 * upstream, so a rename or a dropped field would still compile and would
 * silently serve the dashboard unauthenticated — a bug no type check catches.
 */

import type { DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { bullBoardImports } from './bull-board.imports';
import { BullBoardAuthMiddleware } from './bull-board-auth.middleware';
import { QUEUE_NAMES } from '../queue/queue.constants';

/** Run `bullBoardImports()` with the given env applied, then restore it. */
function importsWithEnv(env: Record<string, string | undefined>) {
  const original = { ...process.env };
  Object.assign(process.env, env);
  try {
    return bullBoardImports();
  } finally {
    process.env = original;
  }
}

const moduleNames = (imports: DynamicModule[]) =>
  imports.map((entry) => entry.module?.name ?? 'unknown');

const BOARD_ENABLED = {
  BULL_BOARD_ENABLED: 'true',
  BULL_BOARD_USER: 'ops',
  BULL_BOARD_PASSWORD: 'secret',
};

type BoardOptions = { middleware: unknown; route: string };

/**
 * Pull the root module's async OPTIONS factory out of the board import.
 *
 * The root module declares several factory providers (options, server adapter,
 * board instance) and they are told apart only by what they produce — so this
 * calls each one and keeps the first that returns an options object. Matching on
 * shape rather than array position keeps the test working if upstream reorders
 * its providers.
 */
function optionsFactory(imports: DynamicModule[]) {
  const board = imports.find((m) => m.module?.name === 'BullBoardModule');
  const root = board?.imports?.[0] as DynamicModule;
  const providers = (root.providers ?? []) as {
    useFactory?: (...args: unknown[]) => unknown;
  }[];

  return async (config: ConfigService): Promise<BoardOptions> => {
    for (const provider of providers) {
      if (!provider.useFactory) continue;
      try {
        const produced = await provider.useFactory(config);
        if (produced && typeof produced === 'object' && 'route' in produced) {
          return produced as BoardOptions;
        }
      } catch {
        // Not the options factory (e.g. the adapter factory, which needs the
        // options object) — keep looking.
      }
    }
    throw new Error('Bull Board options factory not found');
  };
}

describe('bullBoardImports', () => {
  it('mounts nothing when disabled', () => {
    // Disabled means no route exists at all — not merely a guarded one.
    expect(importsWithEnv({ BULL_BOARD_ENABLED: undefined })).toEqual([]);
  });

  it('does not mount on an ambiguous truthy value', () => {
    // '1'/'yes' must not be read as consent to expose the dashboard.
    expect(importsWithEnv({ BULL_BOARD_ENABLED: '1' })).toEqual([]);
    expect(importsWithEnv({ BULL_BOARD_ENABLED: 'yes' })).toEqual([]);
  });

  it('mounts the board and one feature module per queue when enabled', () => {
    const names = moduleNames(importsWithEnv(BOARD_ENABLED));

    expect(names).toContain('BullBoardModule');
    expect(names.filter((n) => n === 'BullBoardFeatureModule')).toHaveLength(
      Object.keys(QUEUE_NAMES).length,
    );
  });

  it('mounts even when credentials are missing, so the gate still denies', () => {
    // Fail-closed, not fail-open: the middleware refuses every request.
    const names = moduleNames(
      importsWithEnv({
        BULL_BOARD_ENABLED: 'true',
        BULL_BOARD_USER: undefined,
        BULL_BOARD_PASSWORD: undefined,
      }),
    );
    expect(names).toContain('BullBoardModule');
  });

  it('attaches BullBoardAuthMiddleware to the board options', async () => {
    const factory = optionsFactory(importsWithEnv(BOARD_ENABLED));

    const options = await factory({
      get: () => undefined,
    } as unknown as ConfigService);

    // The auth gate must be the middleware the board applies before its router.
    expect(options.middleware).toBe(BullBoardAuthMiddleware);
    expect(options.route).toBe('/admin/queues');
  });

  it('honours a custom route', async () => {
    const factory = optionsFactory(importsWithEnv(BOARD_ENABLED));

    const options = await factory({
      get: (key: string) =>
        key === 'BULL_BOARD_ROUTE' ? '/internal/q' : undefined,
    } as unknown as ConfigService);

    expect(options.route).toBe('/internal/q');
  });

  it('registers queues read-only by default', () => {
    const imports = importsWithEnv(BOARD_ENABLED);
    const feature = imports.find(
      (m) => m.module?.name === 'BullBoardFeatureModule',
    ) as DynamicModule;
    const queues = (
      feature.providers?.[0] as {
        useValue: { options: { readOnlyMode: boolean } }[];
      }
    ).useValue;

    // Mutating actions require an explicit opt-out.
    expect(queues[0].options.readOnlyMode).toBe(true);
  });

  it('allows mutations when explicitly opted in', () => {
    const imports = importsWithEnv({
      ...BOARD_ENABLED,
      BULL_BOARD_ALLOW_MUTATIONS: 'true',
    });
    const feature = imports.find(
      (m) => m.module?.name === 'BullBoardFeatureModule',
    ) as DynamicModule;
    const queues = (
      feature.providers?.[0] as {
        useValue: { options: { readOnlyMode: boolean } }[];
      }
    ).useValue;

    expect(queues[0].options.readOnlyMode).toBe(false);
  });
});
