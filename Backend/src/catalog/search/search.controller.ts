import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { resolveRequestLang } from '../../common/app-lang.util';
import { SearchService } from './search.service';
import { SearchDto } from './dto/search.dto';

@ApiTags('Catalog / Search')
@Controller('v1')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  // Category labels follow `Accept-Language` (ru | uz | en, regional tags such
  // as ru-RU widened to their language). Anything missing or unsupported serves
  // the platform default, so a client that sends no header is unaffected. The
  // body's `locale` wins when present — it is the field the app already carries
  // for a user whose in-app language differs from their device's.
  @Post('search')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({
    name: 'Accept-Language',
    required: false,
    description:
      'Display language for category labels: ru | uz | en (regional tags ' +
      'like ru-RU accepted). Defaults to ru.',
  })
  universalSearch(
    @Body() dto: SearchDto,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return this.search.search(dto, resolveRequestLang(dto.locale ?? acceptLanguage));
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
