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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AddressesService } from './addresses.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';

const ADDRESS_EXAMPLE = {
  id: 'addr_01HX…',
  label: 'Home',
  region_code: 'UZ-TK',
  district: 'Yunusobod',
  street: 'Amir Temur 12',
  full_text: 'Amir Temur ko‘chasi 12, Toshkent',
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
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "List the caller's addresses (default first)." })
  @ApiOkResponse({ schema: { example: { items: [ADDRESS_EXAMPLE] } } })
  list(@Request() req: { user: { id: string } }) {
    return this.addresses.list(req.user.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an address. The first address (or is_default: true) becomes the default.',
  })
  @ApiCreatedResponse({ description: 'Address created.', schema: { example: ADDRESS_EXAMPLE } })
  create(@Request() req: { user: { id: string } }, @Body() dto: CreateAddressDto) {
    return this.addresses.create(req.user.id, dto);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Partially update an owned address. is_default: true promotes it atomically.',
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
