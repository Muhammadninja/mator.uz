import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TopFeaturedService } from './top-featured.service';
import { TopFeaturedDto } from './dto/top-featured.dto';

@ApiTags('Catalog / Top Featured')
@Controller('v1/top-featured')
export class TopFeaturedController {
  constructor(private readonly topFeatured: TopFeaturedService) {}

  @Post('list')
  @HttpCode(HttpStatus.OK)
  list(@Body() dto: TopFeaturedDto) {
    return this.topFeatured.list(dto);
  }
}
