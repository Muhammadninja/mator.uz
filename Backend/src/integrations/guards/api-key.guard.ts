import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { DealerStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  hashDealerApiKey,
  safeEqualHex,
  MAX_DEALER_API_KEY_LENGTH,
  MIN_DEALER_API_KEY_LENGTH,
} from '../api-key.util';
import type {
  IntegrationDealer,
  RequestWithDealer,
} from '../interfaces/integration-dealer.interface';

/** Header carrying the dealer's integration credential. */
export const API_KEY_HEADER = 'x-api-key';

/**
 * Authenticates a dealer's 1C integration by the `X-API-KEY` header and attaches
 * the resolved dealer to the request.
 *
 * This is the ONLY thing standing between a public endpoint and the ability to
 * rewrite a dealer's stock and prices, so it fails closed at every step: a
 * missing, blank, malformed or unknown key is a 401, and the key is never
 * logged, echoed, or included in an error message.
 *
 * Only the SHA-256 digest is ever compared — the plaintext key exists in this
 * process for the duration of one request and is never written anywhere. The
 * lookup is a single indexed read on the unique `api_key_hash` column, which is
 * what keeps an invalid-key flood cheap (see api-key.util for why the hash is
 * deliberately fast rather than bcrypt).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithDealer>();
    const presented = this.extractKey(request);

    // Length-bounded before hashing: an absent or obviously malformed
    // credential is rejected without touching the database at all.
    if (
      !presented ||
      presented.length < MIN_DEALER_API_KEY_LENGTH ||
      presented.length > MAX_DEALER_API_KEY_LENGTH
    ) {
      throw new UnauthorizedException('Invalid or missing API key.');
    }

    const presentedHash = hashDealerApiKey(presented);

    const dealer = await this.prisma.catalogSeller.findUnique({
      where: { apiKeyHash: presentedHash },
      select: {
        id: true,
        name: true,
        status: true,
        apiKeyHash: true,
        apiKeyLast4: true,
      },
    });

    // `findUnique` on the digest already establishes equality, but re-check in
    // constant time so no future refactor of this lookup (e.g. to findFirst with
    // extra predicates) can quietly reintroduce a short-circuiting comparison.
    if (
      !dealer?.apiKeyHash ||
      !safeEqualHex(dealer.apiKeyHash, presentedHash)
    ) {
      // Log the FAILURE, never the key or its digest — a digest is as good as
      // the key for an attacker who can look it up.
      this.logger.warn(
        `Rejected integration request with an unrecognized X-API-KEY (ip=${request.ip ?? 'unknown'}).`,
      );
      throw new UnauthorizedException('Invalid or missing API key.');
    }

    // Authentication succeeded but the dealer is not permitted to trade: a
    // suspended or still-pending dealer must not be able to push stock into the
    // buyer catalog. 403, not 401 — the credential IS valid, so retrying with a
    // different key is not the fix and the operator needs to see the difference.
    if (dealer.status !== DealerStatus.ACTIVE) {
      this.logger.warn(
        `Dealer ${dealer.id} presented a valid API key but is ${dealer.status}; refusing the sync.`,
      );
      throw new ForbiddenException(
        `Dealer account is ${dealer.status.toLowerCase()} and cannot sync inventory.`,
      );
    }

    const authenticated: IntegrationDealer = {
      id: dealer.id,
      name: dealer.name,
      status: dealer.status,
      apiKeyLast4: dealer.apiKeyLast4,
    };
    request.dealer = authenticated;
    return true;
  }

  /**
   * Read the header. Express lowercases header names and collapses repeats into
   * an array; take the first value so a duplicated header cannot smuggle a
   * second credential past the check.
   */
  private extractKey(request: RequestWithDealer): string | null {
    const raw = request.headers[API_KEY_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}
