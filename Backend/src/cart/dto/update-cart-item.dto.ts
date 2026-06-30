import { IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateCartItemDto {
  // quantity <= 0 removes the line (per the contract).
  @Type(() => Number)
  @IsInt()
  quantity: number;
}
