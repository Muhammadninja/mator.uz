import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';

@Module({
  imports: [PrismaModule],
  providers: [ProductsService],
  controllers: [ProductsController],
})
export class ProductsModule {}
