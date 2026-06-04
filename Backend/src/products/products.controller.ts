import { Controller, Get, Query, Param, ParseIntPipe } from '@nestjs/common';
import { ProductsService } from './products.service';

@Controller('api/products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  async getProducts(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('brand') brand?: string,
    @Query('model') model?: string,
    @Query('title') title?: string,
    @Query('gmNumber') gmNumber?: string,
  ) {
    return this.productsService.getProducts({
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      brand,
      model,
      title,
      gmNumber,
    });
  }

  @Get('brands')
  async getBrands() {
    return this.productsService.getBrands();
  }

  @Get('brands/:brandId/models')
  async getModelsByBrand(@Param('brandId', ParseIntPipe) brandId: number) {
    return this.productsService.getModelsByBrand(brandId);
  }

  @Get(':id')
  async getProductById(@Param('id', ParseIntPipe) id: number) {
    return this.productsService.getProductById(id);
  }
}
