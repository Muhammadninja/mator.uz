import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** The three tabs of the part-first conveyor. */
export type QueueFilter = 'top300' | 'unmapped' | 'all';

/** GET /v1/admin/fitment/parts-queue?limit&filter&search */
export class GetPartsQueueQueryDto {
  /**
   * One page, and the operator works the whole page — there is no pagination in
   * the studio, the queue IS the page. 500 is the ceiling because the client
   * renders every row and keyboard navigation has to stay smooth.
   */
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 300;

  @IsOptional()
  @IsIn(['top300', 'unmapped', 'all'])
  filter: QueueFilter = 'top300';

  /** Case-insensitive, matches name + brand + OEM/GM number + part id. */
  @IsOptional()
  @IsString()
  search?: string;
}
