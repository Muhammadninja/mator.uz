import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AddressSuggestionsService } from './address-suggestions.service';
import { AddressesService } from './addresses.service';
import { AddressPointQueryDto } from './dto/address-point.query.dto';
import { AddressSuggestionsQueryDto } from './dto/address-suggestions.query.dto';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';

const ADDRESS_EXAMPLE = {
  id: 'addr_01HX…',
  label: 'Home',
  region_code: 'UZ-TK',
  district: 'Yunusobod',
  street: 'Amir Temur 12',
  full_text: 'Amir Temur ko‘chasi 12, Toshkent',
  landmark: 'Blue gate, second entrance',
  lat: 41.31,
  lng: 69.28,
  is_default: true,
  created_at: '2026-07-16T10:00:00.000Z',
  updated_at: '2026-07-16T10:00:00.000Z',
};

/**
 * User address CRUD. All routes require a JWT and operate only on the caller's
 * own addresses. Complements the existing read-only GET /v1/account/addresses
 * (which is left unchanged).
 */
@ApiTags('Addresses')
@ApiBearerAuth('jwt')
@Controller('v1/addresses')
@UseGuards(JwtAuthGuard)
export class AddressesController {
  constructor(
    private readonly addresses: AddressesService,
    private readonly suggestions: AddressSuggestionsService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "List the caller's addresses (default first)." })
  @ApiOkResponse({ schema: { example: { items: [ADDRESS_EXAMPLE] } } })
  list(@Request() req: { user: { id: string } }) {
    return this.addresses.list(req.user.id);
  }

  // Tighter than the global limit: every search is a paid call to the provider.
  @Get('suggestions')
  @Throttle({ default: { limit: 30, ttl: 60 * 1000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Addresses matching what the buyer has typed, each with its point on the map.',
    description:
      'Save the chosen one through POST /v1/addresses. No match is an empty list. 503 ' +
      'ADDRESS_SEARCH_UNAVAILABLE when the search provider gives no answer.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        items: [
          {
            id: '123',
            title: 'Amir Temur 12',
            subtitle: 'Yunusobod, Toshkent',
            city: 'Toshkent',
            district: 'Yunusobod',
            street: 'Amir Temur',
            house_number: '12',
            lat: 41.31,
            lng: 69.28,
          },
        ],
        attribution:
          'Map data © OpenStreetMap contributors, licensed under the ODbL.',
      },
    },
  })
  suggest(@Query() query: AddressSuggestionsQueryDto) {
    return this.suggestions.suggest(query);
  }

  // Same reason. The app asks once per confirmed point, never while the map moves.
  @Get('reverse')
  @Throttle({ default: { limit: 30, ttl: 60 * 1000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What is known about a point the buyer has confirmed on the map.',
    description:
      'Best effort: address is null when nothing is known or the provider gives no answer, ' +
      'and the point is still a valid destination. within_coverage is null when no delivery ' +
      'area is configured.',
  })
  describePoint(@Query() query: AddressPointQueryDto) {
    return this.suggestions.describePoint(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an address. The first address (or is_default: true) becomes the default.',
    description:
      'lat and lng are the place the courier goes, chosen by the buyer: any point in the ' +
      'delivery area, whether or not it has a street address. They come as a pair. full_text ' +
      'may be left out when they are given. 400 DELIVERY_ADDRESS_COORDINATES_INVALID, 422 ' +
      'DELIVERY_OUTSIDE_COVERAGE.',
  })
  @ApiCreatedResponse({ description: 'Address created.', schema: { example: ADDRESS_EXAMPLE } })
  create(@Request() req: { user: { id: string } }, @Body() dto: CreateAddressDto) {
    return this.addresses.create(req.user.id, dto);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Partially update an owned address. is_default: true promotes it atomically.',
    description:
      'A moved point needs a new delivery quote. Refuses a point as POST /v1/addresses does.',
  })
  @ApiOkResponse({ schema: { example: ADDRESS_EXAMPLE } })
  @ApiNotFoundResponse({
    description: 'Address not found or not owned by the caller.',
    schema: { example: { code: 'NOT_FOUND', message: 'Address not found' } },
  })
  update(
    @Request() req: { user: { id: string } },
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.addresses.update(req.user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete an owned address. If it was the default, the newest remaining one is promoted.',
  })
  @ApiOkResponse({ schema: { example: { id: 'addr_01HX…', deleted: true } } })
  @ApiNotFoundResponse({
    description: 'Address not found or not owned by the caller.',
    schema: { example: { code: 'NOT_FOUND', message: 'Address not found' } },
  })
  remove(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.addresses.remove(req.user.id, id);
  }
}
