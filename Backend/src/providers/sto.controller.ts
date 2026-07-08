import { Controller, Get, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ProviderType } from '@prisma/client';
import { ProvidersService } from './providers.service';
import { NearbyQueryDto } from './dto/nearby.query.dto';

@ApiTags('Providers / STO')
@Controller('v1/sto')
export class StoController {
  constructor(private readonly providers: ProvidersService) {}

  @Get('nearby')
  @HttpCode(HttpStatus.OK)
  nearby(@Query() query: NearbyQueryDto) {
    return this.providers.nearby(ProviderType.STO, query);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  detail(@Param('id') id: string) {
    return this.providers.detail(id);
  }
}
