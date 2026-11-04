import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SourcingConfig } from './sourcing.config';

/**
 * What this deployment supports. Public, because guests chat too. The app sends
 * nothing to the sourcing chat until it reads a matching contract version, so it
 * fails closed against a backend without these guarantees.
 */
@ApiTags('Sourcing')
@Controller('v1/sourcing/capabilities')
export class SourcingCapabilitiesController {
  constructor(private readonly config: SourcingConfig) {}

  @Get()
  @ApiOperation({ summary: 'Sourcing contract version and whether tickets are being accepted' })
  capabilities() {
    return {
      contract_version: 2,
      auth_enforced: true,
      idempotency: true,
      vehicle_context: true,
      multi_part: true,
      ticket_submission_enabled: this.config.ticketsEnabled,
    };
  }
}
