import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SourcingOfferService } from './sourcing-offer.service';
import { presentOffer } from './sourcing-offer.presenter';
import { RejectOfferDto } from './dto/reject-offer.dto';

/**
 * Customer-facing sourcing surface. Backs the "found part" notification's
 * tap-through: the offer detail screen loads a single offer, ownership-checked
 * against the authenticated user.
 */
@ApiTags('Sourcing')
@ApiBearerAuth('jwt')
@Controller('v1/sourcing')
@UseGuards(JwtAuthGuard)
export class SourcingController {
  constructor(private readonly offers: SourcingOfferService) {}

  @Get('offers/:id')
  async getOffer(@Req() req: Request, @Param('id') id: string) {
    const userId = (req.user as { id: string }).id;
    const offer = await this.offers.getOfferForUser(id, userId);
    if (!offer) throw new NotFoundException('Offer not found');
    return presentOffer(offer);
  }

  /** Buy: add the offer to the cart, mark it (and the ticket) accepted.
   *  Returns the updated cart snapshot. */
  @Post('offers/:id/accept')
  @HttpCode(HttpStatus.OK)
  accept(@Req() req: Request, @Param('id') id: string) {
    const userId = (req.user as { id: string }).id;
    return this.offers.acceptOffer(id, userId);
  }

  /** Decline the offer with a reason (the ticket stays open for other dealers). */
  @Post('offers/:id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: RejectOfferDto,
  ) {
    const userId = (req.user as { id: string }).id;
    return this.offers.rejectOffer(id, userId, dto.reason, dto.note);
  }
}
