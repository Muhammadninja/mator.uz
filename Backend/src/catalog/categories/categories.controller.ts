import { Controller, Get, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CategoriesService } from './categories.service';
import { ListCategoriesQueryDto } from './dto/list-categories.query.dto';

@ApiTags('Catalog / Categories')
@Controller('v1/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Two-level part category hierarchy with live counts',
    description:
      "scope=main (default) returns the 12 home-page categories; scope=vehicle returns the 8 make/model categories. Pass vehicle_id to scope counts to a garage vehicle.",
  })
  list(@Query() query: ListCategoriesQueryDto) {
    return this.categories.list(query);
  }
}
