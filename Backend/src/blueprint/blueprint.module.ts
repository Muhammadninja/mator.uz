import { Module } from '@nestjs/common';
import { BlueprintController } from './blueprint.controller';
import { BlueprintGateway } from './blueprint.gateway';
import { DbTelemetryService } from './db-telemetry.service';

/**
 * 3D DB Blueprint — operator-only real-time schema visualizer.
 *
 * Mounted conditionally from AppModule (see `isBlueprintEnabled()`), so it does
 * not exist at all in production unless explicitly enabled. PrismaService and
 * EventEmitter2 come from the global PrismaModule / EventEmitterModule.
 *
 *  - {@link DbTelemetryService}: installs the Prisma `$use` timer, emits pulses.
 *  - {@link BlueprintGateway}: `/blueprint` WS, fans pulses to operators.
 *  - {@link BlueprintController}: `GET /blueprint/graph`, `POST /blueprint/ticket`.
 */
@Module({
  controllers: [BlueprintController],
  providers: [DbTelemetryService, BlueprintGateway],
})
export class BlueprintModule {}
