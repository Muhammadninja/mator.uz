import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TopFeaturedService } from './top-featured.service';
import { ListTopFeaturedDto } from './dto/list-top-featured.dto';

/**
 * Top Featured grid API (Phase 4B) — read-only, public (a search-landing
 * merchandising surface, like /v1/categories and /v1/search). Serves the
 * seeded FeaturedItem rows in the shape the frontend top-featured service
 * expects (POST /v1/top-featured/list).
 */
@ApiTags('TopFeatured')
@Controller('v1/top-featured')
export class TopFeaturedController {
  constructor(private readonly topFeatured: TopFeaturedService) {}

  @Post('list')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List featured items with equality filters, paging, sort and derived filter options.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        items: [
          {
            id: 'f1',
            badge: '',
            status: '',
            title: 'Cobalt SUV',
            description: '',
            price: '',
            model: 'SUV',
            brand: 'Cobalt',
            color: 'Black',
            condition: 'New',
            oem: 'GM 15823942',
          },
        ],
        total: 6,
        page: 1,
        pageSize: 24,
        availableFilters: [
          { key: 'brand', title: 'Brand', options: [{ value: 'Cobalt', label: 'Cobalt', count: 2 }] },
        ],
        snapshotVersion: 'featured-6-1752…',
        socketChannel: 'top_featured:catalog',
      },
    },
  })
  list(@Body() dto: ListTopFeaturedDto) {
    return this.topFeatured.list(dto);
  }
}
