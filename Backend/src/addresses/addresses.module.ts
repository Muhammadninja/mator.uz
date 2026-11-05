import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AddressesService } from './addresses.service';
import { AddressesController } from './addresses.controller';
import { AddressSuggestionsService } from './address-suggestions.service';
import { ADDRESS_SEARCH_PROVIDER } from './search/address-search-provider';
import { REVERSE_GEOCODING_PROVIDER } from './search/reverse-geocoding-provider';
import { UzmapsAddressSearchProvider } from './search/uzmaps-address-search.provider';
import { UzmapsReverseGeocodingProvider } from './search/uzmaps-reverse-geocoding.provider';

/**
 * User address CRUD (Phase 4A). PrismaService comes from the global
 * PrismaModule; AuthModule provides the JWT guard the controller uses.
 */
@Module({
  imports: [AuthModule],
  providers: [
    AddressesService,
    AddressSuggestionsService,
    // The one line that names each provider. Search, reverse geocoding and routing
    // (in ShippingModule) can each move to another provider alone.
    { provide: ADDRESS_SEARCH_PROVIDER, useClass: UzmapsAddressSearchProvider },
    {
      provide: REVERSE_GEOCODING_PROVIDER,
      useClass: UzmapsReverseGeocodingProvider,
    },
  ],
  controllers: [AddressesController],
  // Exported so the profile module (PATCH /v1/me) can reuse the same
  // address persistence/validation logic instead of duplicating it.
  exports: [AddressesService],
})
export class AddressesModule {}
