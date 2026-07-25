import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Registry } from 'prom-client';
import { resolveMetricsConfig, type MetricsConfig } from './metrics.config';
import {
  createAppMetrics,
  registerDefaultMetrics,
  type AppMetrics,
} from './metrics.definitions';

/**
 * DI tokens for the metrics primitives. Injecting these (rather than importing
 * a module-level singleton) is what lets a test build an isolated registry per
 * test module, and is why nothing here is global mutable state beyond the
 * Registry object itself.
 */
export const METRICS_CONFIG = Symbol('METRICS_CONFIG');
export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');
export const APP_METRICS = Symbol('APP_METRICS');

/**
 * The three providers MetricsModule binds, in dependency order:
 *
 *   METRICS_CONFIG   ← ConfigService (env)
 *   METRICS_REGISTRY ← a fresh prom-client Registry; default Node/process
 *                      collectors are attached here, once.
 *   APP_METRICS      ← every app metric, constructed once against that registry.
 *
 * Because each is a plain Nest provider, the container instantiates each EXACTLY
 * ONCE per module instance — that singleton guarantee is what makes
 * "metrics are registered only once" a structural property rather than something
 * enforced by a hand-rolled guard flag.
 *
 * When metrics are disabled the registry and metric objects are still built (so
 * nothing injecting them has to null-check), but no default collectors are
 * attached and no route is mounted — see metrics.module.ts. Counters then
 * increment into a registry nobody scrapes, which costs a few map writes and
 * keeps every call site branch-free.
 */
export function metricsProviders(): Provider[] {
  return [
    {
      provide: METRICS_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): MetricsConfig =>
        resolveMetricsConfig(config),
    },
    {
      provide: METRICS_REGISTRY,
      inject: [METRICS_CONFIG],
      useFactory: (config: MetricsConfig): Registry => {
        const registry = new Registry();
        if (config.enabled) {
          registerDefaultMetrics(registry, config);
        }
        return registry;
      },
    },
    {
      provide: APP_METRICS,
      inject: [METRICS_REGISTRY, METRICS_CONFIG],
      useFactory: (registry: Registry, config: MetricsConfig): AppMetrics =>
        createAppMetrics(registry, config),
    },
  ];
}
