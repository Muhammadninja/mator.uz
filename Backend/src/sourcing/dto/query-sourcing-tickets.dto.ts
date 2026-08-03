import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { SourcingTicketStatus } from '@prisma/client';

/**
 * Query of GET /v1/admin/sourcing-tickets. All fields optional. The global
 * ValidationPipe runs with `whitelist: true, forbidNonWhitelisted: true`, so
 * this class IS the accepted-field whitelist. `limit` is additionally clamped
 * server-side (see SourcingService) so the ceiling holds even off this path.
 */
export class QuerySourcingTicketsDto {
  @ApiPropertyOptional({
    enum: SourcingTicketStatus,
    description: 'Filter by lifecycle status. Omit to return every status.',
  })
  @IsOptional()
  @IsEnum(SourcingTicketStatus)
  status?: SourcingTicketStatus;

  @ApiPropertyOptional({ description: '1-based page number.', default: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Page size (1–100).', default: 20, example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
