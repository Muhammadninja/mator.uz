import { Controller, Get, Request, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AccountService } from './account.service';

@Controller('v1/account')
@UseGuards(JwtAuthGuard)
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get('addresses')
  @HttpCode(HttpStatus.OK)
  addresses(@Request() req: { user: { id: string } }) {
    return this.account.listAddresses(req.user.id);
  }

  @Get('payment-methods')
  @HttpCode(HttpStatus.OK)
  paymentMethods() {
    return this.account.paymentMethods();
  }
}
