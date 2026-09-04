import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { DealerStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { generateDealerApiKey, hashDealerApiKey } from '../api-key.util';
import { ApiKeyGuard } from './api-key.guard';

type MockRequest = {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  dealer?: unknown;
};

function contextFor(request: MockRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** The columns the guard selects from CatalogSeller. */
interface DealerRow {
  id: string;
  name: string;
  status: DealerStatus;
  apiKeyHash: string | null;
  apiKeyLast4: string | null;
}

describe('ApiKeyGuard', () => {
  const findUnique = jest.fn<Promise<DealerRow | null>, [{ where: unknown }]>();
  const prisma = {
    catalogSeller: { findUnique },
  } as unknown as PrismaService;
  let guard: ApiKeyGuard;

  const { rawKey, hash } = generateDealerApiKey();
  const activeDealer = {
    id: 'dealer_1',
    name: 'AutoPro',
    status: DealerStatus.ACTIVE,
    apiKeyHash: hash,
    apiKeyLast4: rawKey.slice(-4),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new ApiKeyGuard(prisma);
  });

  it('accepts a valid key and attaches the dealer to the request', async () => {
    findUnique.mockResolvedValue(activeDealer);
    const request: MockRequest = { headers: { 'x-api-key': rawKey } };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.dealer).toEqual({
      id: 'dealer_1',
      name: 'AutoPro',
      status: DealerStatus.ACTIVE,
      apiKeyLast4: rawKey.slice(-4),
    });
  });

  it('looks the dealer up by DIGEST, never by the raw key', async () => {
    findUnique.mockResolvedValue(activeDealer);

    await guard.canActivate(contextFor({ headers: { 'x-api-key': rawKey } }));

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { apiKeyHash: hashDealerApiKey(rawKey) },
      }) as { where: unknown },
    );
    const queried = JSON.stringify(findUnique.mock.calls[0][0]);
    expect(queried).not.toContain(rawKey);
  });

  it('tolerates surrounding whitespace in the header', async () => {
    findUnique.mockResolvedValue(activeDealer);

    await expect(
      guard.canActivate(
        contextFor({ headers: { 'x-api-key': `  ${rawKey}  ` } }),
      ),
    ).resolves.toBe(true);
  });

  it('uses the first value when the header is sent twice', async () => {
    findUnique.mockResolvedValue(activeDealer);

    await guard.canActivate(
      contextFor({
        headers: { 'x-api-key': [rawKey, 'attacker-supplied-key'] },
      }),
    );

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { apiKeyHash: hashDealerApiKey(rawKey) },
      }) as { where: unknown },
    );
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['too short', 'short-key'],
    ['too long', 'x'.repeat(400)],
  ])(
    'rejects a %s key with 401 without querying the database',
    async (_label, value) => {
      const headers = value === undefined ? {} : { 'x-api-key': value };

      await expect(
        guard.canActivate(contextFor({ headers })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(findUnique).not.toHaveBeenCalled();
    },
  );

  it('rejects an unknown key with 401', async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      guard.canActivate(contextFor({ headers: { 'x-api-key': rawKey } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a dealer row whose apiKeyHash is null', async () => {
    findUnique.mockResolvedValue({ ...activeDealer, apiKeyHash: null });

    await expect(
      guard.canActivate(contextFor({ headers: { 'x-api-key': rawKey } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([DealerStatus.PENDING, DealerStatus.SUSPENDED])(
    'rejects a valid key for a %s dealer with 403',
    async (status) => {
      findUnique.mockResolvedValue({ ...activeDealer, status });

      await expect(
        guard.canActivate(contextFor({ headers: { 'x-api-key': rawKey } })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('never puts the key or its digest in the error message', async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      guard.canActivate(contextFor({ headers: { 'x-api-key': rawKey } })),
    ).rejects.toMatchObject({ message: 'Invalid or missing API key.' });
  });
});
