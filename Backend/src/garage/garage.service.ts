import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateUserCarDto {
  userId: number;
  make: string;
  model: string;
  year?: number;
  vin?: string;
}

export interface UpdateUserCarDto {
  make?: string;
  model?: string;
  year?: number;
  vin?: string;
}

@Injectable()
export class GarageService {
  constructor(private prisma: PrismaService) {}

  // Get all cars for a user
  async getUserCars(userId: number) {
    return this.prisma.userCar.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Get single car
  async getUserCarById(carId: number, userId: number) {
    const car = await this.prisma.userCar.findUnique({
      where: { id: carId },
    });

    if (!car || car.userId !== userId) {
      throw new NotFoundException('Car not found');
    }

    return car;
  }

  // Create new car
  async createUserCar(dto: CreateUserCarDto) {
    // First, ensure user exists
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.prisma.userCar.create({
      data: {
        userId: dto.userId,
        make: dto.make,
        model: dto.model,
        year: dto.year,
        vin: dto.vin,
      },
    });
  }

  // Update car
  async updateUserCar(carId: number, userId: number, dto: UpdateUserCarDto) {
    // Verify ownership
    const car = await this.prisma.userCar.findUnique({
      where: { id: carId },
    });

    if (!car || car.userId !== userId) {
      throw new NotFoundException('Car not found');
    }

    return this.prisma.userCar.update({
      where: { id: carId },
      data: dto,
    });
  }

  // Delete car
  async deleteUserCar(carId: number, userId: number) {
    // Verify ownership
    const car = await this.prisma.userCar.findUnique({
      where: { id: carId },
    });

    if (!car || car.userId !== userId) {
      throw new NotFoundException('Car not found');
    }

    return this.prisma.userCar.delete({
      where: { id: carId },
    });
  }
}
