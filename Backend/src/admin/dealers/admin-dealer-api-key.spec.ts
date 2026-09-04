import { AdminAuditAction, AdminAuditEntity } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CloudinaryService } from '../../cloudinary/cloudinary.service';
import { AdminAuditService } from '../auth/admin-audit.service';
import { AdminAuditContext } from '../auth/admin-auth.service';
import {
  DEALER_API_KEY_PREFIX,
  hashDealerApiKey,
} from '../../integrations/api-key.util';
import { AdminDealersService } from './admin-dealers.service';

const ctx: AdminAuditContext = {
  actor: { id: 'adm_1', email: 'ops@mator.uz', name: 'Ops' },
  ip: '127.0.0.1',
  userAgent: 'jest',
};

interface SellerUpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}

describe('AdminDealersService — 1C API key', () => {
  const findUnique = jest.fn<Promise<unknown>, [unknown]>();
  const update = jest.fn<Promise<unknown>, [SellerUpdateArgs]>();
  const record = jest.fn<
    Promise<unknown>,
    [Record<string, unknown>, unknown]
  >();

  const tx = { catalogSeller: { findUnique, update } };
  const prisma = {
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
  const audit = { record } as unknown as AdminAuditService;
  const cloudinary = {} as unknown as CloudinaryService;

  let service: AdminDealersService;

  const dealerRow = { id: 'd1', name: 'AutoPro', status: 'ACTIVE' };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AdminDealersService(prisma, audit, cloudinary);
    update.mockResolvedValue({});
    record.mockResolvedValue({});
  });

  describe('issueApiKey', () => {
    beforeEach(() => {
      // requireDealer, then the previous-key read.
      findUnique
        .mockResolvedValueOnce(dealerRow)
        .mockResolvedValueOnce({ apiKeyLast4: null, apiKeyIssuedAt: null });
    });

    it('returns a prefixed plaintext key exactly once', async () => {
      const result = await service.issueApiKey('d1', ctx);

      expect(result.success).toBe(true);
      expect(result.data.apiKey).toMatch(
        new RegExp(`^${DEALER_API_KEY_PREFIX}[A-Za-z0-9_-]{20,}$`),
      );
      expect(result.data.apiKeyLast4).toBe(result.data.apiKey.slice(-4));
    });

    it('stores only the DIGEST, never the plaintext', async () => {
      const result = await service.issueApiKey('d1', ctx);

      const { data } = update.mock.calls[0][0];
      expect(data.apiKeyHash).toBe(hashDealerApiKey(result.data.apiKey));
      expect(JSON.stringify(data)).not.toContain(result.data.apiKey);
    });

    it('clears the liveness stamp so a rotation starts a fresh history', async () => {
      await service.issueApiKey('d1', ctx);

      expect(update.mock.calls[0][0].data.apiKeyLastUsedAt).toBeNull();
    });

    it('audits the issuance without recording the key or its digest', async () => {
      const result = await service.issueApiKey('d1', ctx);

      const entry = record.mock.calls[0][0];
      expect(entry.action).toBe(AdminAuditAction.DEALER_API_KEY_ISSUED);
      expect(entry.target).toMatchObject({
        entity: AdminAuditEntity.DEALER,
        id: 'd1',
      });
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(result.data.apiKey);
      expect(serialized).not.toContain(hashDealerApiKey(result.data.apiKey));
    });

    it('issues a different key every time', async () => {
      const first = await service.issueApiKey('d1', ctx);
      findUnique.mockResolvedValueOnce(dealerRow).mockResolvedValueOnce({
        apiKeyLast4: 'aaaa',
        apiKeyIssuedAt: new Date(),
      });
      const second = await service.issueApiKey('d1', ctx);

      expect(second.data.apiKey).not.toBe(first.data.apiKey);
    });
  });

  describe('revokeApiKey', () => {
    it('clears every key column and audits the revocation', async () => {
      findUnique
        .mockResolvedValueOnce(dealerRow)
        .mockResolvedValueOnce({ apiKeyHash: 'deadbeef', apiKeyLast4: '8f2c' });

      const result = await service.revokeApiKey('d1', ctx);

      expect(result).toEqual({
        success: true,
        data: { dealerId: 'd1', revoked: true },
      });
      expect(update.mock.calls[0][0].data).toEqual({
        apiKeyHash: null,
        apiKeyLast4: null,
        apiKeyIssuedAt: null,
        apiKeyLastUsedAt: null,
      });
      expect(record.mock.calls[0][0].action).toBe(
        AdminAuditAction.DEALER_API_KEY_REVOKED,
      );
    });

    it('is a no-op when the dealer has no key', async () => {
      findUnique
        .mockResolvedValueOnce(dealerRow)
        .mockResolvedValueOnce({ apiKeyHash: null, apiKeyLast4: null });

      await expect(service.revokeApiKey('d1', ctx)).resolves.toMatchObject({
        success: true,
      });
      expect(update).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });
  });
});
