import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GarageService } from './garage.service';

interface UserCarBody {
  make: string;
  model: string;
  year?: number;
  vin?: string;
}

@Controller('api/garage')
@UseGuards(JwtAuthGuard)
export class GarageController {
  constructor(private readonly garageService: GarageService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  getUserCars(@Request() req: { user: { id: number } }) {
    return this.garageService.getUserCars(req.user.id);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  getUserCarById(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: { user: { id: number } },
  ) {
    return this.garageService.getUserCarById(id, req.user.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  createUserCar(
    @Body() body: UserCarBody,
    @Request() req: { user: { id: number } },
  ) {
    return this.garageService.createUserCar({ userId: req.user.id, ...body });
  }

  @Post(':id')
  @HttpCode(HttpStatus.OK)
  updateUserCar(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Partial<UserCarBody>,
    @Request() req: { user: { id: number } },
  ) {
    return this.garageService.updateUserCar(id, req.user.id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  deleteUserCar(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: { user: { id: number } },
  ) {
    return this.garageService.deleteUserCar(id, req.user.id);
  }
}
