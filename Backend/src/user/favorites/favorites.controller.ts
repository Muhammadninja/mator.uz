import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import {
  FavoriteImportDto,
  FavoriteListDto,
  FavoritePartDto,
} from './favorites.dto';
import { FavoritesService } from './favorites.service';

type PrincipalRequest = { user: { id: string } };

@ApiTags('User / Favorites')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('v1/me/favorites')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  list(@Request() req: PrincipalRequest, @Query() dto: FavoriteListDto) {
    return this.favorites.list(req.user.id, dto);
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Additively import up to 100 local favorite IDs; retries are idempotent.',
  })
  import(@Request() req: PrincipalRequest, @Body() dto: FavoriteImportDto) {
    return this.favorites.import(req.user.id, dto.partIds, dto.importId);
  }

  @Put(':partId')
  @HttpCode(HttpStatus.OK)
  add(@Request() req: PrincipalRequest, @Param() dto: FavoritePartDto) {
    return this.favorites.add(req.user.id, dto.partId);
  }

  @Delete(':partId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Request() req: PrincipalRequest, @Param() dto: FavoritePartDto) {
    return this.favorites.remove(req.user.id, dto.partId);
  }
}
