import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { SourcingOfferDeclineReason } from '@prisma/client';

/** Body for `POST /v1/sourcing/offers/:id/reject`. */
export class RejectOfferDto {
  @IsEnum(SourcingOfferDeclineReason)
  reason: SourcingOfferDeclineReason;

  /** Optional free-text detail — most useful with reason OTHER. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
