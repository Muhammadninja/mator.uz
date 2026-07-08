import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaymentsService } from './payments.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';

@ApiTags('Payments')
@ApiBearerAuth('jwt')
@Controller('v1/payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('payme/invoices')
  @HttpCode(HttpStatus.CREATED)
  payme(@Request() req: { user: { id: string } }, @Body() dto: CreateInvoiceDto) {
    return this.payments.createPaymeInvoice(req.user.id, dto);
  }

  @Post('click/invoices')
  @HttpCode(HttpStatus.CREATED)
  click(@Request() req: { user: { id: string } }, @Body() dto: CreateInvoiceDto) {
    return this.payments.createClickInvoice(req.user.id, dto);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  status(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.payments.getPayment(req.user.id, id);
  }
}
