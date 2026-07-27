import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Sort fields the admin users list accepts (mapped to real columns in the service). */
export const ADMIN_USER_SORT_FIELDS = ['createdAt', 'name'] as const;
export type AdminUserSortField = (typeof ADMIN_USER_SORT_FIELDS)[number];

/**
 * Query params for GET /v1/admin/users. Same conventions as the admin orders
 * list: offset pagination (page/limit), free-text search, whitelisted sort
 * validated with `@IsIn` so client input never reaches Prisma's `orderBy`
 * unchecked.
 *
 * Sorting is limited to columns that exist on AppUser. Spend/order-count are
 * computed per page from the Order table rather than stored on the user, so
 * they are deliberately NOT offered as sort fields — sorting by them would
 * require aggregating every user's orders on every request.
 */
export class ListAdminUsersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsString()
  @IsIn(ADMIN_USER_SORT_FIELDS, {
    message: 'sortBy is not a supported sort field',
  })
  sortBy?: AdminUserSortField;

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'], { message: 'order must be asc or desc' })
  order?: 'asc' | 'desc';
}
