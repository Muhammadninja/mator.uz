/**
 * Seeds the buyer-facing catalog (vehicle catalog + parts) with the contract's
 * canonical IDs so the Garage and Catalog flows work end-to-end.
 *
 * Idempotent — safe to run repeatedly:  npx ts-node src/prisma/seed-catalog.ts
 */
import {
  PrismaClient,
  FuelType,
  PartCondition,
  CompatibilityStatus,
  ProviderType,
  Specialization,
} from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // ── Vehicle catalog ──────────────────────────────────────────────────────
  await prisma.vehicleMake.upsert({
    where: { id: 'make_chevrolet' },
    update: {},
    create: { id: 'make_chevrolet', name: 'Chevrolet', logoUrl: 'https://cdn.mator.uz/brands/chevrolet.svg', sortOrder: 1 },
  });

  await prisma.vehicleModelRef.upsert({
    where: { id: 'model_chevrolet_cobalt' },
    update: {},
    create: { id: 'model_chevrolet_cobalt', makeId: 'make_chevrolet', name: 'Cobalt' },
  });

  for (const [id, name] of [
    ['trim_chevrolet_cobalt_ls_at', 'LS AT'],
    ['trim_chevrolet_cobalt_lt_at', 'LT AT'],
  ]) {
    await prisma.vehicleTrim.upsert({
      where: { id },
      update: {},
      create: { id, modelId: 'model_chevrolet_cobalt', name },
    });
  }

  await prisma.vehicleEngine.upsert({
    where: { id: 'engine_b15d2_1_5l_petrol' },
    update: {},
    create: { id: 'engine_b15d2_1_5l_petrol', name: 'B15D2 1.5L', displacementCc: 1485, fuelType: FuelType.PETROL },
  });

  await prisma.vehicle3dAsset.upsert({
    where: { id: 'asset_cobalt_2019_ls' },
    update: {},
    create: {
      id: 'asset_cobalt_2019_ls',
      trimId: 'trim_chevrolet_cobalt_ls_at',
      glbUrl: 'https://cdn.mator.uz/3d/chevrolet/cobalt/2019/ls/model_v3.glb',
      ktx2TexturesUrl: 'https://cdn.mator.uz/3d/chevrolet/cobalt/2019/ls/textures_ktx2.zip',
      version: 3,
      byteSize: 18643217,
      checksumSha256: 'a1f4c9d7b2e0f8a6c5d3e2b1a0f9e8d7c6b5a4938271605142331f0e9d8c7b6a',
    },
  });

  for (const [id, name, thumb] of [
    ['tuning_stock', 'Stock', 'stock.webp'],
    ['tuning_sport', 'Sport Pack', 'sport.webp'],
    ['tuning_offroad', 'Offroad Pack', 'offroad.webp'],
  ]) {
    await prisma.tuningVariant.upsert({
      where: { id },
      update: {},
      create: {
        id,
        assetId: 'asset_cobalt_2019_ls',
        name,
        thumbnailUrl: `https://cdn.mator.uz/3d/chevrolet/cobalt/2019/ls/thumbs/${thumb}`,
      },
    });
  }

  // ── Parts catalog ────────────────────────────────────────────────────────
  await prisma.partCategory.upsert({
    where: { id: 'cat_engine_belts' },
    update: {},
    create: { id: 'cat_engine_belts', name: 'Dvigatel kamarlari' },
  });

  for (const [id, name] of [
    ['brand_gates', 'Gates'],
    ['brand_dayco', 'Dayco'],
  ]) {
    await prisma.partBrand.upsert({ where: { id }, update: {}, create: { id, name } });
  }

  await prisma.catalogSeller.upsert({
    where: { id: 'seller_avtomir' },
    update: {},
    create: { id: 'seller_avtomir', name: 'Avtomir TM', ratingAvg: 4.7 },
  });

  await prisma.catalogPart.upsert({
    where: { id: 'part_01HXC3KK5B3C9S9LK0N1AB2X9V' },
    update: {},
    create: {
      id: 'part_01HXC3KK5B3C9S9LK0N1AB2X9V',
      title: 'Cobalt Remen Generator Xitoy Original',
      brandId: 'brand_gates',
      categoryId: 'cat_engine_belts',
      sellerId: 'seller_avtomir',
      oemNumbers: ['96440756', '55562234'],
      priceUzs: 185000,
      condition: PartCondition.NEW,
      inStock: true,
      stockQty: 47,
      deliveryEtaDaysMin: 1,
      deliveryEtaDaysMax: 2,
      images: [
        'https://cdn.mator.uz/parts/01HXC3KK5B/main.webp',
        'https://cdn.mator.uz/parts/01HXC3KK5B/02.webp',
      ],
    },
  });

  // A second part on a different brand so quick-filters/facets show variety.
  await prisma.catalogPart.upsert({
    where: { id: 'part_dayco_belt_cobalt' },
    update: {},
    create: {
      id: 'part_dayco_belt_cobalt',
      title: 'Cobalt Remen Dayco',
      brandId: 'brand_dayco',
      categoryId: 'cat_engine_belts',
      sellerId: 'seller_avtomir',
      oemNumbers: ['96440756'],
      priceUzs: 165000,
      condition: PartCondition.NEW,
      inStock: true,
      stockQty: 12,
      deliveryEtaDaysMin: 1,
      deliveryEtaDaysMax: 3,
      images: ['https://cdn.mator.uz/parts/dayco/main.webp'],
    },
  });

  for (const [id, partId, trimId, years] of [
    ['cmp_gates_ls', 'part_01HXC3KK5B3C9S9LK0N1AB2X9V', 'trim_chevrolet_cobalt_ls_at', [2018, 2019, 2020, 2021]],
    ['cmp_gates_lt', 'part_01HXC3KK5B3C9S9LK0N1AB2X9V', 'trim_chevrolet_cobalt_lt_at', [2019, 2020, 2021]],
    ['cmp_dayco_ls', 'part_dayco_belt_cobalt', 'trim_chevrolet_cobalt_ls_at', [2018, 2019, 2020]],
  ] as const) {
    await prisma.partCompatibility.upsert({
      where: { id },
      update: {},
      create: {
        id,
        partId,
        trimId,
        engineId: 'engine_b15d2_1_5l_petrol',
        years: [...years],
        status: CompatibilityStatus.FITS,
        confidence: 0.97,
        source: 'manufacturer_oem_mapping',
      },
    });
  }

  // ── Top Featured ─────────────────────────────────────────────────────────
  await prisma.featuredItem.upsert({
    where: { id: 'f1' },
    update: {},
    create: {
      id: 'f1',
      badge: 'Top',
      status: 'Ready',
      title: 'Turbo Wheel Set',
      description: 'Forged alloy wheels for sharp handling and cleaner street stance.',
      priceUzs: 1240000,
      model: 'SUV',
      brand: 'Cobalt',
      color: 'Black',
      condition: 'New',
      oem: 'GM 15823942',
      sortOrder: 1,
    },
  });

  // ── Service providers (masters + STO) ────────────────────────────────────
  await prisma.serviceProvider.upsert({
    where: { id: 'master_01HXC3KG7T8U5O5LK0N1AB2X9V' },
    update: {},
    create: {
      id: 'master_01HXC3KG7T8U5O5LK0N1AB2X9V',
      providerType: ProviderType.MASTER,
      displayName: "Bobur Toshpo'latov",
      shopName: 'Bobur Auto Servis',
      bio: "10 yillik tajriba. Chevrolet va Daewoo bo'yicha mutaxassis.",
      avatarUrl: 'https://cdn.mator.uz/masters/bobur/avatar.jpg',
      ratingAvg: 4.82,
      ratingCount: 312,
      geoLat: 41.314211,
      geoLng: 69.247885,
      geohash: 'tzevvtjhx',
      addressText: "Toshkent sh., Yunusobod tumani, Amir Temur ko'chasi 24",
      priceFloorUzs: 80000,
      priceCeilingUzs: 2500000,
      badge: 'verified',
      contactPhoneE164: '+998901112233',
      contactTelegram: '@boburautoservis',
      specializations: {
        create: [{ specialization: Specialization.ENGINE }, { specialization: Specialization.TRANSMISSION }],
      },
      supportedMakes: { create: [{ makeId: 'make_chevrolet' }] },
      services: {
        create: [
          { id: 'svc_diag_full', name: "To'liq diagnostika", durationMin: 60, priceUzs: 150000 },
          { id: 'svc_oil_change', name: "Yog' almashtirish", durationMin: 30, priceUzs: 90000 },
        ],
      },
      workingHours: {
        create: [1, 2, 3, 4, 5].map((weekday) => ({
          id: `wh_bobur_${weekday}`,
          weekday,
          openTime: '09:00',
          closeTime: '20:00',
        })),
      },
      certifications: {
        create: [
          {
            id: 'cert_uz_mech_lvl3',
            name: "O'zbekiston Avto-mexanika sertifikati, 3-daraja",
            issuedAt: new Date('2022-03-14'),
          },
        ],
      },
      portfolio: {
        create: [
          { id: 'pf_bobur_1', imageUrl: 'https://cdn.mator.uz/masters/bobur/portfolio/p1.jpg', sortOrder: 1 },
          { id: 'pf_bobur_2', imageUrl: 'https://cdn.mator.uz/masters/bobur/portfolio/p2.jpg', sortOrder: 2 },
        ],
      },
    },
  });

  await prisma.serviceProvider.upsert({
    where: { id: 'sto_01HXC3KG9V0W6P6LK0N1AB2X9V' },
    update: {},
    create: {
      id: 'sto_01HXC3KG9V0W6P6LK0N1AB2X9V',
      providerType: ProviderType.STO,
      displayName: 'Avtotex STO',
      shopName: 'Avtotex STO',
      avatarUrl: 'https://cdn.mator.uz/sto/avtotex/logo.jpg',
      ratingAvg: 4.61,
      ratingCount: 188,
      geoLat: 41.30245,
      geoLng: 69.2312,
      geohash: 'tzeu4rjyk',
      addressText: "Toshkent sh., Chilonzor tumani, Bunyodkor shoh ko'chasi 18",
      priceFloorUzs: 150000,
      priceCeilingUzs: 8500000,
      badge: 'premium',
      specializations: {
        create: [
          { specialization: Specialization.BODY },
          { specialization: Specialization.PAINT },
          { specialization: Specialization.ELECTRICAL },
        ],
      },
      supportedMakes: { create: [{ makeId: 'make_chevrolet' }] },
      services: {
        create: [{ id: 'svc_body_diag', name: 'Kuzov diagnostikasi', durationMin: 45, priceUzs: 200000 }],
      },
      workingHours: {
        create: [1, 2, 3, 4, 5, 6].map((weekday) => ({
          id: `wh_avtotex_${weekday}`,
          weekday,
          openTime: '09:00',
          closeTime: weekday === 6 ? '18:00' : '20:00',
        })),
      },
    },
  });

  console.log('✅ Catalog + providers seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
