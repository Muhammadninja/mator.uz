import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { isBlueprintEnabled } from '../blueprint/blueprint-auth';

// When the operator DB Blueprint is enabled we ask Prisma to EMIT query events
// (instead of its default silent behaviour) so `DbTelemetryService` can turn
// each query into a live visualization pulse. This is purely additive — it
// changes no query behaviour, only surfaces a `query` event carrying the SQL +
// duration. Gated on the same flag that mounts BlueprintModule, so production
// (blueprint off) pays nothing. Prisma 6 removed `$use` middleware; the query
// event stream is the supported interception point.
const PRISMA_LOG_OPTIONS = isBlueprintEnabled()
  ? { log: [{ emit: 'event' as const, level: 'query' as const }] }
  : undefined;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super(PRISMA_LOG_OPTIONS);
  }

  async onModuleInit() {
    await this.$connect();
  }
}
