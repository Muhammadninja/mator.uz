import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { SourcingTicketStatus } from '@prisma/client';

/** Body of PATCH /v1/admin/sourcing-tickets/:id/status. */
export class UpdateTicketStatusDto {
  @ApiProperty({
    enum: SourcingTicketStatus,
    description: 'New status (PENDING -> IN_PROGRESS -> OFFERED -> CLOSED).',
  })
  @IsEnum(SourcingTicketStatus)
  status: SourcingTicketStatus;
}
