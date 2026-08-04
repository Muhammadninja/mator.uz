import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SourcingOfferService } from './sourcing-offer.service';
import { presentOffer } from './sourcing-offer.presenter';

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
}
