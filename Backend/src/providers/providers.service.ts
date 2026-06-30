import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProviderType, Specialization } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NearbyQueryDto } from './dto/nearby.query.dto';
import { haversineMeters, bboxFromRadius } from './geo.util';
import {
  PROVIDER_NEARBY_INCLUDE,
  PROVIDER_DETAIL_INCLUDE,
  presentNearby,
  presentDetail,
  isOpenNow,
} from './provider.presenter';

const DEFAULT_RADIUS_M = 5000;
const DEFAULT_LIMIT = 50;
const PREFILTER_CAP = 300;

@Injectable()
export class ProvidersService {
  constructor(private readonly prisma: PrismaService) {}

  async nearby(type: ProviderType, query: NearbyQueryDto) {
    const start = Date.now();
    const now = new Date();
    const radius = query.radius_m ?? DEFAULT_RADIUS_M;

    const box =
      query.viewport_min_lat != null &&
      query.viewport_min_lng != null &&
      query.viewport_max_lat != null &&
      query.viewport_max_lng != null
        ? {
            minLat: query.viewport_min_lat,
            maxLat: query.viewport_max_lat,
            minLng: query.viewport_min_lng,
            maxLng: query.viewport_max_lng,
          }
        : bboxFromRadius(query.center_lat, query.center_lng, radius);

    const where: Prisma.ServiceProviderWhereInput = {
      providerType: type,
      isActive: true,
      geoLat: { gte: box.minLat, lte: box.maxLat },
      geoLng: { gte: box.minLng, lte: box.maxLng },
    };
    if (query.min_rating != null) where.ratingAvg = { gte: query.min_rating };

    const specs = this.parseSpecializations(query.specialization ?? query.service_types);
    if (specs.length) where.specializations = { some: { specialization: { in: specs } } };
    if (query.vehicle_make_id) where.supportedMakes = { some: { makeId: query.vehicle_make_id } };

    const providers = await this.prisma.serviceProvider.findMany({
      where,
      include: PROVIDER_NEARBY_INCLUDE,
      take: PREFILTER_CAP,
    });

    let ranked = providers
      .map((p) => ({ p, d: haversineMeters(query.center_lat, query.center_lng, p.geoLat, p.geoLng) }))
      .filter((x) => x.d <= radius)
      .sort((a, b) => a.d - b.d);

    if (query.open_now === 'true') {
      ranked = ranked.filter((x) => isOpenNow(x.p.workingHours, now));
    }

    const limit = query.limit ?? DEFAULT_LIMIT;
    return {
      results: ranked.slice(0, limit).map((x) => presentNearby(x.p, x.d, now)),
      cluster_hints: [],
      next_cursor: null,
      total: ranked.length,
      query_duration_ms: Date.now() - start,
    };
  }

  async detail(id: string) {
    const provider = await this.prisma.serviceProvider.findUnique({
      where: { id },
      include: PROVIDER_DETAIL_INCLUDE,
    });
    if (!provider) throw new NotFoundException('Provider not found');
    return presentDetail(provider);
  }

  private parseSpecializations(csv?: string): Specialization[] {
    if (!csv) return [];
    return csv
      .split(',')
      .map((s) => Specialization[s.trim().toUpperCase() as keyof typeof Specialization])
      .filter((s): s is Specialization => !!s);
  }
}
