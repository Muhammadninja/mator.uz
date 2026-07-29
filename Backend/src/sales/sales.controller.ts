import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SalesService } from './sales.service';

/**
 * Public sales feed (/v1/sales) — read-only, unauthenticated, like
 * /v1/dealers and /v1/categories.
 *
 * Informational only: it tells a client WHICH campaigns are running so they can
 * be merchandised. Clients never compute a discount from it — prices arrive
 * already discounted by the backend (DiscountService), which is the single
 * source of truth for what anything costs.
 */
@ApiTags('Sales')
@Controller('v1/sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List the currently active sales.',
    description:
      'Only sales that are live right now: `isActive` is true, `startAt` has passed, ' +
      'and `endAt` is either null (open-ended) or still in the future. Ordered by ' +
      'priority, then most recently started.\n\n' +
      'The activeness test is the same predicate the pricing path uses, so this list ' +
      'can never advertise a sale that pricing would decline to apply. Operational ' +
      'fields (priority, isActive, target ids) are deliberately not exposed.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        items: [
          {
            id: 'sale_01HXC3KF8Q2M4N6P8R0T2V4X6Z',
            title: 'Summer brake sale',
            description: '15% off all brake pads',
            discountType: 'PERCENT',
            discountValue: 15,
            scopeType: 'CATEGORIES',
            startAt: '2026-07-01T00:00:00.000Z',
            endAt: '2026-08-31T23:59:59.000Z',
          },
        ],
      },
    },
  })
  list() {
    return this.sales.listPublic();
  }
}
