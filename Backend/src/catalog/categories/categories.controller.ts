import {
  Controller,
  Get,
  Headers,
  Query,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { resolveRequestLang } from '../../common/app-lang.util';
import { OptionalJwtForVehicleGuard } from '../../auth/guards/optional-jwt-auth.guard';
import { CategoriesService } from './categories.service';
import { ListCategoriesQueryDto } from './dto/list-categories.query.dto';

@ApiTags('Catalog / Categories')
@Controller('v1/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalJwtForVehicleGuard)
  @ApiOperation({
    summary: 'Two-level part category hierarchy with live counts',
    description:
      "scope=main (default) returns the 12 home-page categories; scope=vehicle returns the 8 make/model categories. Pass vehicle_id to scope counts to a garage vehicle — only the authenticated caller's own; any other id is treated like an unknown vehicle (unscoped counts).",
  })
  @ApiHeader({
    name: 'Accept-Language',
    required: false,
    description:
      'Display language for `label`: ru | uz | en (regional tags like ru-RU ' +
      'accepted). Defaults to ru.',
  })
  list(
    @Query() query: ListCategoriesQueryDto,
    @Request() req: { user?: { id: string } | null },
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return this.categories.list(
      query,
      resolveRequestLang(acceptLanguage),
      req.user?.id ?? null,
    );
  }
}
