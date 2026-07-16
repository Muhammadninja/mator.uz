import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DealersService } from './dealers.service';

/**
 * "MATOR Certified" dealers (Phase 4C) — read-only, public (an Explore
 * merchandising row, like /v1/categories). Serves the curated CatalogSeller
 * rows in the frontend MatorDealer shape.
 */
@ApiTags('Dealers')
@Controller('v1/dealers')
export class DealersController {
  constructor(private readonly dealers: DealersService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List the MATOR Certified dealers.' })
  @ApiOkResponse({
    schema: {
      example: {
        items: [
          { id: 'd1', name: 'AutoPro Parts', initial: 'A', color: '#2A6FDB', orders: '18k+', years: 12 },
        ],
      },
    },
  })
  list() {
    return this.dealers.list();
  }
}
