import { IsOptional, IsString, IsInt, Min, Max, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

/** Keyset-paginated inbox query. `cursor` is the last seen notification id. */
export class ListNotificationsQuery {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  // `unread` restricts to not-yet-read notifications; defaults to `all`.
  @IsOptional()
  @IsIn(['all', 'unread'])
  filter?: 'all' | 'unread';
}
