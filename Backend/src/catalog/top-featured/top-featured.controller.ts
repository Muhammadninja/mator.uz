import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { TopFeaturedService } from './top-featured.service';
import { TopFeaturedDto } from './dto/top-featured.dto';

@Controller('v1/top-featured')
export class TopFeaturedController {
  constructor(private readonly topFeatured: TopFeaturedService) {}

  @Post('list')
  @HttpCode(HttpStatus.OK)
  list(@Body() dto: TopFeaturedDto) {
    return this.topFeatured.list(dto);
  }
}
