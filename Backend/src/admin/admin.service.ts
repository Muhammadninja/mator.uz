import { Injectable } from '@nestjs/common';
import { SellerStatus } from '@prisma/client';
import { SellersService } from '../sellers/sellers.service';

@Injectable()
export class AdminService {
  constructor(private readonly sellers: SellersService) {}

  listSellers(status?: SellerStatus) {
    return this.sellers.findAll(status);
  }

  listPending() {
    return this.sellers.findPending();
  }

  approveSeller(id: number) {
    return this.sellers.updateStatus(id, SellerStatus.ACTIVE);
  }

  rejectSeller(id: number) {
    return this.sellers.updateStatus(id, SellerStatus.REJECTED);
  }
}
