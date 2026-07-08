import { Controller, Post, Get, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { SearchDto } from './dto/search.dto';

@ApiTags('Catalog / Search')
@Controller('v1')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Post('search')
  @HttpCode(HttpStatus.OK)
  universalSearch(@Body() dto: SearchDto) {
    return this.search.search(dto);
  }

  @Get('typeahead')
  @HttpCode(HttpStatus.OK)
  typeahead(@Query('q') q: string, @Query('limit') limit?: string) {
    return this.search.typeahead(q ?? '', limit ? parseInt(limit, 10) : 6);
  }

  @Get('search/quick-filters')
  @HttpCode(HttpStatus.OK)
  quickFilters(@Query('limit') limit?: string) {
    return this.search.quickFilters(limit ? parseInt(limit, 10) : 8);
  }
}
