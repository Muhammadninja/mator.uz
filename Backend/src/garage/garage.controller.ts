import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  Headers,
} from '@nestjs/common';
import { GarageService } from './garage.service';

interface UserCarBody {
  make: string;
  model: string;
  year?: number;
  vin?: string;
}

// In production, you'd use @UseGuards(AuthGuard) and get userId from request.user
// For now, we'll get it from the X-User-Id header for demo purposes
function extractUserId(headers: any): number {
  const userId = headers['x-user-id'];
  if (!userId) {
    throw new Error('X-User-Id header is required');
  }
  return parseInt(userId, 10);
}

@Controller('api/garage')
export class GarageController {
  constructor(private readonly garageService: GarageService) {}

  @Get()
  async getUserCars(@Headers() headers: any) {
    const userId = extractUserId(headers);
    return this.garageService.getUserCars(userId);
  }

  @Get(':id')
  async getUserCarById(
    @Param('id', ParseIntPipe) id: number,
    @Headers() headers: any,
  ) {
    const userId = extractUserId(headers);
    return this.garageService.getUserCarById(id, userId);
  }

  @Post()
  async createUserCar(@Body() body: UserCarBody, @Headers() headers: any) {
    const userId = extractUserId(headers);
    return this.garageService.createUserCar({
      userId,
      ...body,
    });
  }

  @Post(':id')
  async updateUserCar(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Partial<UserCarBody>,
    @Headers() headers: any,
  ) {
    const userId = extractUserId(headers);
    return this.garageService.updateUserCar(id, userId, body);
  }

  @Delete(':id')
  async deleteUserCar(
    @Param('id', ParseIntPipe) id: number,
    @Headers() headers: any,
  ) {
    const userId = extractUserId(headers);
    return this.garageService.deleteUserCar(id, userId);
  }
}
