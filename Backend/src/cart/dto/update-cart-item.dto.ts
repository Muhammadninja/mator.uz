import { IsInt, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_CART_ITEM_QUANTITY } from './add-cart-item.dto';

export class UpdateCartItemDto {
  // quantity <= 0 removes the line (per the contract), so there is no lower
  // bound; the upper bound caps realistic quantities (see MAX_CART_ITEM_QUANTITY).
  @Type(() => Number)
  @IsInt()
  @Max(MAX_CART_ITEM_QUANTITY)
  quantity: number;
}
