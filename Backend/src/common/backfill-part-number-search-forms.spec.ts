// CAT-001: the backfill's gates, against a fake client. No database is reachable here.
const findMany = jest.fn();
const update = jest.fn();
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => ({
    catalogPart: { findMany, update },
    $disconnect: jest.fn(),
  })),
}));

const ROWS = [
  { id: 'a', gmNumbers: ['96 953 062'], oemNumbers: [] },
  { id: 'b', gmNumbers: ['96953062'], oemNumbers: ['sp-1362', 'SP1362'] },
];
const SCRIPT = '../../prisma/backfill-part-number-search-forms';
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

async function run(...args: string[]): Promise<string> {
  jest.resetModules();
  process.argv = ['node', 'script', ...args];
  const log = jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
  require(SCRIPT); // eslint-disable-line @typescript-eslint/no-require-imports
  await flush();
  return log.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('backfill:part-number-search-forms', () => {
  const argv = process.argv;
  beforeEach(() => {
    process.exitCode = undefined;
    update.mockReset();
    findMany.mockReset();
    findMany.mockResolvedValueOnce(ROWS).mockResolvedValue([]);
  });
  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  it('writes nothing by default', async () => {
    expect(await run()).toContain('1 parts need a lookup form');
    expect(update).not.toHaveBeenCalled();
  });

  it('--apply without the digest writes nothing', async () => {
    await run('--apply');
    expect(update).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('--apply with a wrong digest writes nothing', async () => {
    await run('--apply', '--confirm=0000');
    expect(update).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('with the digest it appends the lookup form, keeps the original first, and merges nothing', async () => {
    const output = await run();
    const digest = /digest=([0-9a-f]+)/.exec(output)![1];
    findMany.mockReset();
    findMany.mockResolvedValueOnce(ROWS).mockResolvedValue([]);
    await run('--apply', `--confirm=${digest}`);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'a' },
      data: { gmNumbers: ['96 953 062', '96953062'], oemNumbers: [] },
    });
  });
});
