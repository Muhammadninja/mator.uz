// ING-004: the gate, and each real script run through it over a recording client.
import {
  MaintenanceRefusal,
  describeDatabase,
  planCode,
  runMaintenance,
} from './maintenance-guard';
import { runBackfill } from '../../prisma/backfill-catalog';
import { runFixSlugs } from '../../prisma/fix-category-slugs';
import { runSeedTitles } from '../../prisma/seed-category-titles';
import { runFixture } from '../../scripts/create-payme-test-fixture';
import { runCreateAdmin } from '../../scripts/create-admin';

const LOCAL = { DATABASE_URL: 'postgresql://u:p@localhost:5432/mator_dev' };
const REMOTE = { DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/neondb' };
const silent = { log: () => undefined };

function gate(env: NodeJS.ProcessEnv, argv: string[], items: unknown[] = [1]) {
  const apply = jest.fn().mockResolvedValue(undefined);
  const result = runMaintenance({
    script: 's',
    argv,
    env,
    ...silent,
    buildPlan: () => Promise.resolve({ summary: [], items }),
    apply,
  });
  return { apply, result };
}
const codeFor = (env: NodeJS.ProcessEnv, items: unknown[] = [1]) =>
  planCode('s', describeDatabase(env).label, items);

describe('runMaintenance', () => {
  it('writes nothing without flags', async () => {
    const { apply, result } = gate(LOCAL, []);
    await expect(result).resolves.toBe('dry_run');
    expect(apply).not.toHaveBeenCalled();
  });

  it('writes nothing for --apply without a confirmation', async () => {
    const { apply, result } = gate(LOCAL, ['--apply']);
    await expect(result).rejects.toBeInstanceOf(MaintenanceRefusal);
    expect(apply).not.toHaveBeenCalled();
  });

  it('writes nothing for a wrong confirmation', async () => {
    const { apply, result } = gate(LOCAL, ['--apply', '--confirm=deadbeef']);
    await expect(result).rejects.toThrow('does not match');
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies with the code of exactly this plan', async () => {
    const { apply, result } = gate(LOCAL, [
      '--apply',
      `--confirm=${codeFor(LOCAL)}`,
    ]);
    await expect(result).resolves.toBe('applied');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('a changed plan invalidates the earlier code', async () => {
    const stale = codeFor(LOCAL, [1]);
    const { apply, result } = gate(
      LOCAL,
      ['--apply', `--confirm=${stale}`],
      [2],
    );
    await expect(result).rejects.toThrow('does not match');
    expect(apply).not.toHaveBeenCalled();
  });

  it('a code from another database does not confirm', () => {
    expect(codeFor(LOCAL)).not.toBe(codeFor(REMOTE));
  });

  it('is independent of key order', () => {
    expect(planCode('s', 'd', [{ a: 1, b: 2 }])).toBe(
      planCode('s', 'd', [{ b: 2, a: 1 }]),
    );
  });

  it('refuses a remote database without its name, even with the right code', async () => {
    const { apply, result } = gate(REMOTE, [
      '--apply',
      `--confirm=${codeFor(REMOTE)}`,
    ]);
    await expect(result).rejects.toThrow(
      '--allow-database=ep-x.neon.tech/neondb',
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies to a remote database that is named exactly', async () => {
    const { apply, result } = gate(REMOTE, [
      '--apply',
      `--confirm=${codeFor(REMOTE)}`,
      '--allow-database=ep-x.neon.tech/neondb',
    ]);
    await expect(result).resolves.toBe('applied');
    expect(apply).toHaveBeenCalled();
  });

  it('does not take NODE_ENV as proof: a remote URL is remote in development', () => {
    expect(describeDatabase({ ...REMOTE, NODE_ENV: 'development' }).local).toBe(
      false,
    );
  });

  it('treats a loopback database in production as non-local', () => {
    expect(describeDatabase({ ...LOCAL, NODE_ENV: 'production' }).local).toBe(
      false,
    );
  });

  it.each([[{}], [{ DATABASE_URL: '' }], [{ DATABASE_URL: 'not a url' }]])(
    'refuses an unknown target before planning: %j',
    async (env) => {
      const buildPlan = jest.fn();
      await expect(
        runMaintenance({
          script: 's',
          argv: [],
          env,
          ...silent,
          buildPlan,
          apply: jest.fn(),
        }),
      ).rejects.toBeInstanceOf(MaintenanceRefusal);
      expect(buildPlan).not.toHaveBeenCalled();
    },
  );

  it('never prints the password in the database URL', async () => {
    const lines: string[] = [];
    await runMaintenance({
      script: 's',
      argv: [],
      env: REMOTE,
      log: (l) => lines.push(l),
      buildPlan: () => Promise.resolve({ summary: [], items: [1] }),
      apply: jest.fn(),
    });
    expect(lines.join()).not.toContain('u:p');
  });
});

/** A Prisma client that returns no rows and records any attempt to write. */
function recordingClient(rows: Record<string, unknown[]> = {}, counts = 0) {
  const writes: string[] = [];
  const write = new Set([
    'create',
    'createMany',
    'update',
    'updateMany',
    'upsert',
    'delete',
    'deleteMany',
  ]);
  const client = new Proxy(
    {},
    {
      get(_t, model: string) {
        if (model === '$transaction') {
          return () => {
            writes.push('$transaction');
            return Promise.resolve();
          };
        }
        return new Proxy(
          {},
          {
            get(_m, method: string) {
              return () => {
                if (write.has(method)) writes.push(`${model}.${method}`);
                if (method === 'findMany')
                  return Promise.resolve(rows[model] ?? []);
                if (method === 'count') return Promise.resolve(counts);
                return Promise.resolve(null);
              };
            },
          },
        );
      },
    },
  );
  return { client: client as never, writes };
}

describe('the destructive scripts write nothing by default', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  const product = {
    id: 1,
    title: 'Oil filter Cobalt',
    description: null,
    partNumberType: null,
    mainCategory: 'stale',
    vehicleCategory: null,
    partBrand: null,
    originRegion: null,
    isOem: false,
    isGm: false,
    partModels: [],
  };
  // No --password: it is refused on the command line (INFO-11).
  const adminArgs = ['--email=a@example.com', '--name=A'];

  it.each([
    [
      'backfill:catalog',
      runBackfill,
      { product: [product], stock: [{ id: 1 }] },
      [],
    ],
    [
      'fix:category-slugs',
      runFixSlugs,
      { partCategory: [{ id: 'transmission', slug: 'x' }] },
      [],
    ],
    [
      'seed:category-titles',
      runSeedTitles,
      { partCategory: [{ id: 'brake-system', nameRu: 'x' }] },
      [],
    ],
    ['payme:fixture', runFixture, {}, []],
    ['payme:fixture --reset', runFixture, {}, ['--reset']],
    ['admin:create', runCreateAdmin, {}, adminArgs],
  ] as [string, typeof runFixture, Record<string, unknown[]>, string[]][])(
    '%s: no flags, and --apply with a wrong code',
    async (_name, run, rows, args) => {
      const { client, writes } = recordingClient(rows, 3);
      await expect(run(client, args, LOCAL)).resolves.toBe('dry_run');
      await expect(
        run(client, [...args, '--apply'], LOCAL),
      ).rejects.toBeInstanceOf(MaintenanceRefusal);
      await expect(
        run(client, [...args, '--apply', '--confirm=0000000000000000'], LOCAL),
      ).rejects.toBeInstanceOf(MaintenanceRefusal);
      expect(writes).toEqual([]);
    },
  );

  it('payme:fixture --reset: the code covers how many rows it would delete', async () => {
    const lines: string[] = [];
    (console.log as jest.Mock).mockImplementation((l: string) => lines.push(l));
    await runFixture(recordingClient({}, 1).client, ['--reset'], LOCAL);
    const one = lines.join();
    lines.length = 0;
    await runFixture(recordingClient({}, 2).client, ['--reset'], LOCAL);
    const code = (text: string) => /--confirm=(\w+)/.exec(text)![1];
    expect(code(one)).not.toBe(code(lines.join()));
  });

  it('refuses a production URL with a correct code but no explicit name', async () => {
    const lines: string[] = [];
    (console.log as jest.Mock).mockImplementation((l: string) => lines.push(l));
    const { client, writes } = recordingClient({}, 1);
    await runFixture(client, ['--reset'], REMOTE);
    const code = /--confirm=(\w+)/.exec(lines.join())![1];
    await expect(
      runFixture(client, ['--reset', '--apply', `--confirm=${code}`], REMOTE),
    ).rejects.toThrow('--allow-database');
    expect(writes).toEqual([]);
  });
});

// INFO-11: the admin bootstrap never takes a password on argv.
describe('admin:create password input', () => {
  it.each([['--password=abcdefghijkl'], ['--password', 'abcdefghijkl']])(
    'refuses %j before touching the database',
    async (...flag) => {
      const prisma = { appAdmin: { findUnique: jest.fn() } };
      expect(() =>
        runCreateAdmin(
          prisma as never,
          ['--email=a@example.com', '--name=A', ...flag],
          LOCAL,
        ),
      ).toThrow(/process list and shell history/);
      expect(prisma.appAdmin.findUnique).not.toHaveBeenCalled();
    },
  );
});
