/**
 * END-TO-END Garage vehicle image lifecycle against REAL services:
 *
 *   real PostgreSQL (TEST_DATABASE_URL)  ←  real backend services (Garage create,
 *   identity resolution, outbox, delivery, reconcile, admin review + audit)  →
 *   real Vehicle Image Pipeline over HTTP (VEHICLE_IMAGE_E2E_PIPELINE_URL; artwork
 *   provider on, paid generation off, publication to its local store)
 *
 * Only the BullMQ transport is replaced: jobs the services enqueue are run by the
 * real VehicleImagesProcessor in process. Skipped unless VEHICLE_IMAGE_E2E=1.
 * Writes a JSON report to VEHICLE_IMAGE_E2E_REPORT when set.
 *
 *   VEHICLE_IMAGE_E2E=1 TEST_DATABASE_URL=… VEHICLE_IMAGE_E2E_PIPELINE_URL=http://127.0.0.1:8049 \
 *   VEHICLE_IMAGE_E2E_REQUEST_TOKEN=… VEHICLE_IMAGE_E2E_ADMIN_TOKEN=… \
 *   npx jest --config ./test/jest-integration.json --runInBand test/integration/vehicle-image-e2e.int-spec.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { deflateSync } from 'node:zlib';
import { ConfigService } from '@nestjs/config';
import { AdminAuditAction, AdminRole, VehicleImageStatus } from '@prisma/client';
import { describeWithDb, integrationPrisma } from '../utils/integration-db';
import { VehicleImagePipelineClient } from '../../src/garage/vehicle-images/vehicle-image.pipeline-client';
import { VehicleImagePipelineAdminClient } from '../../src/garage/vehicle-images/vehicle-image.pipeline-admin-client';
import { VehicleImageDeliveryService } from '../../src/garage/vehicle-images/vehicle-image.delivery.service';
import { VehicleImagesService } from '../../src/garage/vehicle-images/vehicle-images.service';
import { VehicleImageReconcileService } from '../../src/garage/vehicle-images/vehicle-image.reconcile.service';
import { VehicleImagesProcessor } from '../../src/garage/vehicle-images/vehicle-images.processor';
import { VehiclesService } from '../../src/garage/vehicles/vehicles.service';
import { AdminAuditService } from '../../src/admin/auth/admin-audit.service';
import { AdminVehicleImagesService } from '../../src/admin/vehicle-images/admin-vehicle-images.service';

const E2E = process.env.VEHICLE_IMAGE_E2E === '1';
const describeE2E = E2E ? describeWithDb : describe.skip;
const PIPELINE = process.env.VEHICLE_IMAGE_E2E_PIPELINE_URL ?? '';

/** BullMQ stand-in: collects jobs; `drain` runs them through the real processor. */
class InProcessQueue {
  jobs: Array<{ name: string; data: unknown }> = [];
  add(name: string, data: unknown) {
    this.jobs.push({ name, data });
    return Promise.resolve({});
  }
  addBulk(list: Array<{ name: string; data: unknown }>) {
    this.jobs.push(...list.map(({ name, data }) => ({ name, data })));
    return Promise.resolve([]);
  }
  upsertJobScheduler() { return Promise.resolve(); }
  removeJobScheduler() { return Promise.resolve(); }
}

describeE2E('Garage vehicle images end to end (real PostgreSQL + real pipeline)', () => {
  jest.setTimeout(120_000);
  const prisma = integrationPrisma();
  const queue = new InProcessQueue();
  const config = new ConfigService({
    VEHICLE_IMAGES_ENABLED: 'true',
    VEHICLE_IMAGE_PIPELINE_URL: PIPELINE,
    VEHICLE_IMAGE_REQUEST_TOKEN: process.env.VEHICLE_IMAGE_E2E_REQUEST_TOKEN,
    VEHICLE_IMAGE_ADMIN_TOKEN: process.env.VEHICLE_IMAGE_E2E_ADMIN_TOKEN,
  });
  const client = new VehicleImagePipelineClient(config);
  const adminClient = new VehicleImagePipelineAdminClient(config);
  const delivery = new VehicleImageDeliveryService(prisma as never, client, queue as never);
  const images = new VehicleImagesService(prisma as never, delivery, queue as never);
  const reconcile = new VehicleImageReconcileService(prisma as never, images);
  const processor = new VehicleImagesProcessor(delivery, reconcile, queue as never, config);
  const vehicles = new VehiclesService(
    prisma as never,
    { emitGarageEvent: () => undefined } as never,
    { emit: () => Promise.resolve() } as never,
    images,
  );
  const audit = new AdminAuditService(prisma as never);
  const admin = new AdminVehicleImagesService(prisma as never, adminClient, delivery, reconcile, audit);
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), steps: [] as unknown[] };
  const step = (name: string, detail: unknown) => (report.steps as unknown[]).push({ name, detail });
  const users: string[] = [];
  let ctx: { actor: { id: string; email: string; name: string }; ip: string; userAgent: string };

  async function drain() {
    for (let i = 0; i < 500 && queue.jobs.length; i += 1) {
      const job = queue.jobs.shift()!;
      await processor.process(job as never);
    }
  }

  /** Wait until the pipeline has no queued or running acquisition job. */
  async function pipelineIdle() {
    for (let i = 0; i < 60; i += 1) {
      const metrics = (await adminClient.metrics()) as { jobs?: Record<string, number> };
      if (!metrics.jobs?.queued && !metrics.jobs?.running) return metrics;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('pipeline did not go idle');
  }

  async function syncAll() {
    const rows = await prisma.vehicleImageIdentity.findMany({ select: { identityKey: true } });
    for (const row of rows) await delivery.syncNow(row.identityKey);
  }

  const user = async () => {
    const id = (await prisma.appUser.create({ data: { id: randomUUID() } })).id;
    users.push(id);
    return id;
  };
  const add = (userId: string, model_id: string, year: number, extra: Record<string, unknown> = {}) =>
    vehicles.create(userId, { make_id: (extra.make_id as string) ?? 'chevrolet', model_id, year, ...extra } as never) as Promise<any>;
  const view = async (userId: string, vehicleId: string) => {
    const v: any = await vehicles.getImage(userId, vehicleId);
    const full: any = await vehicles.get(userId, vehicleId);
    return { identity: full.identity, generation: full.generation, vehicle_image: v.vehicle_image };
  };

  beforeAll(async () => {
    expect(PIPELINE).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const health = await delivery.health(true);
    step('pipeline health', health);
    expect(health).toMatchObject({ ready: true, registryMatches: true, contract: 2 });
    for (const make of [
      { id: 'chevrolet', name: 'Chevrolet' },
      { id: 'toyota', name: 'Toyota' },
    ]) await prisma.vehicleMake.upsert({ where: { id: make.id }, update: {}, create: make });
    const models: Array<Record<string, unknown>> = [
      { id: 'cobalt', name: 'Cobalt', bodyType: 'Sedan' },
      { id: 'nexia', name: 'Nexia' },
      { id: 'spark', name: 'Spark' },
      { id: 'tracker', name: 'Tracker' },
      { id: 'tracker-2', name: 'Tracker' },
      { id: 'malibu', name: 'Malibu' },
      { id: 'captiva', name: 'Captiva' },
      { id: 'camry', name: 'Camry', makeId: 'toyota', bodyType: 'Sedan' },
    ];
    for (const m of models)
      await prisma.vehicleModelRef.upsert({ where: { id: m.id as string }, update: {}, create: { makeId: 'chevrolet', ...m } as never });
    for (const [id, name, yearFrom, yearTo] of [['nexia-1', 'Nexia 1', 1996, 2008], ['nexia-2', 'Nexia 2', 2008, 2016], ['nexia-3', 'Nexia 3', 2016, 2022]] as const)
      await prisma.vehicleModelRef.upsert({ where: { id }, update: {}, create: { id, makeId: 'chevrolet', name, yearFrom, yearTo, variantOfModelId: 'nexia' } });
    for (const [id, modelId, name] of [['malibu-1-lt', 'malibu', 'LT'], ['malibu-2-premier', 'malibu', 'Premier'], ['captiva-5-premier', 'captiva', 'Premier']] as const)
      await prisma.vehicleTrim.upsert({ where: { id }, update: {}, create: { id, modelId, name } });
    const adminRow = await prisma.appAdmin.create({
      data: { email: `e2e-${randomUUID().slice(0, 8)}@mator.test`, passwordHash: 'x', name: 'E2E Manager', role: AdminRole.MANAGER },
    });
    ctx = { actor: { id: adminRow.id, email: adminRow.email, name: adminRow.name }, ip: '127.0.0.1', userAgent: 'e2e' };
  });

  afterAll(async () => {
    if (process.env.VEHICLE_IMAGE_E2E_REPORT)
      writeFileSync(process.env.VEHICLE_IMAGE_E2E_REPORT, JSON.stringify(report, null, 2));
    await prisma.$disconnect();
  });

  it('runs the whole lifecycle: add → identity → queue → pipeline → review → publication → Garage', async () => {
    const owner = await user();
    const added: Record<string, any> = {};
    added.cobalt2020 = await add(owner, 'cobalt', 2020);
    added.nexia2018 = await add(owner, 'nexia', 2018);
    added.nexia2012 = await add(owner, 'nexia', 2012);
    added.nexia2016 = await add(owner, 'nexia', 2016);
    added.spark2019 = await add(owner, 'spark', 2019);
    added.tracker2022 = await add(owner, 'tracker', 2022);
    added.tracker2_2015 = await add(owner, 'tracker-2', 2015);
    added.malibu1_2014 = await add(owner, 'malibu', 2014, { trim_id: 'malibu-1-lt' });
    added.malibu2_2021 = await add(owner, 'malibu', 2021, { trim_id: 'malibu-2-premier' });
    added.captiva2017 = await add(owner, 'captiva', 2017, { trim_id: 'captiva-5-premier' });
    added.camry2021 = await add(owner, 'camry', 2021, { make_id: 'toyota' });
    added.cobalt2012 = await add(owner, 'cobalt', 2012);
    // Eight more owners of a Nexia 2, one of each verified year.
    const nexia2Owners: Array<{ userId: string; vehicleId: string; year: number }> = [];
    for (const year of [2009, 2010, 2011, 2013, 2014, 2015, 2016, 2012]) {
      const userId = await user();
      const v = await add(userId, year === 2016 ? 'nexia-2' : 'nexia', year);
      nexia2Owners.push({ userId, vehicleId: v.id, year });
    }
    step('added', Object.fromEntries(Object.entries(added).map(([k, v]) => [k, { identity: v.identity, image: v.vehicle_image, generation: v.generation?.status ?? null }])));

    // Immediately: approved registry images, no pipeline; Nexia 2016 asks the owner.
    expect(added.cobalt2020.vehicle_image).toMatchObject({ status: 'approved', catalog_asset_key: 'cobalt-gen2' });
    expect(added.nexia2018.vehicle_image).toMatchObject({ status: 'approved', catalog_asset_key: 'nexia-r3' });
    expect(added.nexia2016.generation.status).toBe('choice_required');
    expect(added.nexia2016.identity.status).toBe('needs_review');
    expect(added.camry2021.identity).toMatchObject({ status: 'unverified', model_id: 'camry', market: null });
    expect(added.cobalt2012.identity).toMatchObject({ status: 'unverified', market: null });

    // Queue → pipeline; the pipeline proposes repository artwork on its own.
    await drain();
    const idle = await pipelineIdle();
    await syncAll();
    step('pipeline after acquisition', idle);
    const states: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(added)) states[k] = (await view(owner, v.id)).vehicle_image;
    step('Garage states after acquisition', states);
    expect(states.nexia2012).toMatchObject({ status: 'pending', stage: 'awaiting_review' });
    expect(states.spark2019).toMatchObject({ status: 'pending', stage: 'awaiting_review' });
    expect(states.camry2021).toMatchObject({ status: 'pending', stage: 'awaiting_review' });
    expect(states.cobalt2012).toMatchObject({ status: 'pending', stage: 'awaiting_review' });

    const queueEntries = await admin.queue();
    const bySubject = Object.fromEntries(queueEntries.map((e) => [
      `${e.identity.modelId}:${e.identity.modelYear}${e.identity.trimId ? `:${e.identity.trimId}` : ''}`,
      { status: e.status, candidates: e.candidates.map((c) => c.catalogAssetId ?? c.source), members: e.members.length, garageVehicles: e.garageVehicles },
    ]));
    step('review queue', bySubject);
    const nexiaSubject = queueEntries.find((e) => e.subjectKey === 'catalog:nexia-n150')!;
    expect(nexiaSubject.candidates.map((c) => c.catalogAssetId)).toEqual(['nexia-n150']);
    expect(nexiaSubject.members.length + 1).toBe(8); // 2009..2016: one subject, one job
    const entryFor = (modelId: string, extra: (e: (typeof queueEntries)[number]) => boolean = () => true) =>
      queueEntries.find((e) => e.identity.modelId === modelId && extra(e))!;
    expect(entryFor('tracker').candidates.map((c) => c.catalogAssetId)).toEqual(['tracker-gen3']);
    expect(entryFor('tracker-2').candidates).toHaveLength(0);
    expect(entryFor('malibu', (e) => e.identity.trimId === 'malibu-1-lt').candidates).toHaveLength(0);
    expect(entryFor('malibu', (e) => e.identity.trimId === 'malibu-2-premier').candidates.map((c) => c.catalogAssetId))
      .toEqual(['malibu-gen2-facelift']);
    expect(entryFor('captiva').candidates).toHaveLength(0);
    expect(entryFor('camry').status).toBe('awaiting_source');
    expect(entryFor('cobalt').status).toBe('awaiting_source');

    // Review: verified Nexia 2 needs no confirmation; unverified Spark does.
    const confirm = { confirmed: true as const, reference: 'E2E reviewer compared body, grille and lamps with the reference pack' };
    await admin.approve(nexiaSubject.candidates[0].id, {}, ctx);
    const spark = entryFor('spark');
    await expect(admin.approve(spark.candidates[0].id, {}, ctx)).rejects.toMatchObject({ status: 409 });
    await admin.approve(spark.candidates[0].id, { identityConfirmation: confirm, scope: { yearFrom: 2010, yearTo: 2022 } }, ctx);
    const malibu2 = entryFor('malibu', (e) => e.identity.trimId === 'malibu-2-premier');
    await admin.approve(malibu2.candidates[0].id, { identityConfirmation: confirm }, ctx);
    const tracker = entryFor('tracker');
    await admin.reject(tracker.candidates[0].id, 'E2E: generation not confirmed by the owner', ctx);
    await expect(admin.retry(tracker.requestId, ctx)).rejects.toMatchObject({ status: 409 });

    // A new make: no source at all, so a person supplies the image (synthetic test fixture, not a real Camry).
    const camry = entryFor('camry');
    const fixture = syntheticTransparentPng();
    await admin.upload(camry.requestId, { buffer: fixture, mimetype: 'image/png', size: fixture.length }, ctx);
    const camryCandidate = (await admin.queue()).find((e) => e.requestId === camry.requestId)!.candidates.find((c) => c.status === 'pending')!;
    await admin.approve(camryCandidate.id, { identityConfirmation: { confirmed: true, reference: 'E2E synthetic fixture, flow demonstration only' } }, ctx);

    const after: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(added)) after[k] = (await view(owner, v.id)).vehicle_image;
    step('Garage states after review', after);
    for (const key of ['nexia2012', 'spark2019', 'malibu2_2021', 'camry2021'])
      expect(after[key]).toMatchObject({ status: 'approved', url: expect.stringMatching(/^https:\/\/127\.0\.0\.1:8449\/assets\//) });
    for (const owned of nexia2Owners)
      expect((await view(owned.userId, owned.vehicleId)).vehicle_image).toMatchObject({ status: 'approved' });
    expect(after.tracker2022).toMatchObject({ status: 'unavailable', reason: 'rejected' });
    for (const key of ['tracker2_2015', 'malibu1_2014', 'captiva2017', 'cobalt2012'])
      expect(after[key]).toMatchObject({ status: 'pending', stage: 'awaiting_review' });

    // The generation choice resolves the ambiguous Nexia 2016 to the approved Nexia 3 image.
    const picked: any = await vehicles.update(owner, added.nexia2016.id, { variant_model_id: 'nexia-3' } as never);
    expect(picked.vehicle_image).toMatchObject({ status: 'approved', catalog_asset_key: 'nexia-r3' });

    // A later owner inside the approved Spark scope: reused at once, no new job.
    const later = await user();
    const spark2015 = await add(later, 'spark', 2015);
    const jobsBefore = ((await adminClient.metrics()) as { jobs: Record<string, number> }).jobs;
    await drain();
    expect((await view(later, spark2015.id)).vehicle_image).toMatchObject({ status: 'approved' });
    expect(((await adminClient.metrics()) as { jobs: Record<string, number> }).jobs).toEqual(jobsBefore);

    // A vehicle saved before identities existed is re-resolved and shows the image.
    const legacyId = `veh_${randomUUID()}`;
    await prisma.vehicle.create({ data: { id: legacyId, userId: owner, makeId: 'chevrolet', modelId: 'spark', year: 2018, imageReviewReason: 'market_unverified' } });
    expect((await view(owner, legacyId)).vehicle_image).toMatchObject({ status: 'unavailable', reason: 'needs_review' });
    const reconciled = await reconcile.run({ apply: true });
    await drain();
    await syncAll();
    step('reconcile', { scanned: reconciled.scanned, upgraded: reconciled.upgraded, changes: reconciled.changes });
    expect((await view(owner, legacyId)).vehicle_image).toMatchObject({ status: 'approved' });

    // The published file is served over HTTPS as an immutable 1200x600 WebP.
    const url = (after.spark2019 as { url: string }).url;
    const served = await fetchSelfSigned(url);
    step('published file', { url, ...served });
    expect(served).toMatchObject({ status: 200, contentType: 'image/webp', webp: true, cacheControl: expect.stringContaining('immutable') });

    // Pipeline outage: the backend records the precise cause; recovery after the fix.
    const deadConfig = new ConfigService({
      VEHICLE_IMAGES_ENABLED: 'true',
      VEHICLE_IMAGE_PIPELINE_URL: 'http://127.0.0.1:8099',
      VEHICLE_IMAGE_REQUEST_TOKEN: process.env.VEHICLE_IMAGE_E2E_REQUEST_TOKEN,
    });
    const deadDelivery = new VehicleImageDeliveryService(prisma as never, new VehicleImagePipelineClient(deadConfig), queue as never);
    const deadImages = new VehicleImagesService(prisma as never, deadDelivery, queue as never);
    const outageVehicles = new VehiclesService(prisma as never, { emitGarageEvent: () => undefined } as never, { emit: () => Promise.resolve() } as never, deadImages);
    const outage = await outageVehicles.create(owner, { make_id: 'chevrolet', model_id: 'spark', year: 2011 } as never) as any;
    const job = queue.jobs.shift()!;
    expect(await deadDelivery.dispatch(job.data as never)).toBe('retry_scheduled');
    const failing = await prisma.vehicle.findUniqueOrThrow({ where: { id: outage.id }, include: { imageIdentity: true } });
    step('outage', { lastError: failing.imageIdentity?.lastError, garage: (await view(owner, outage.id)).vehicle_image });
    expect(failing.imageIdentity?.lastError).toBe('network:ECONNREFUSED');
    await prisma.vehicleImageOutbox.updateMany({ where: { identityKey: failing.imageIdentityKey! }, data: { availableAt: new Date() } });
    await delivery.relayDue();
    await drain();
    await syncAll();
    expect((await view(owner, outage.id)).vehicle_image).toMatchObject({ status: 'approved' });

    const status = await admin.status();
    step('admin status', status);
    const audits = await prisma.adminAudit.findMany({ where: { actorId: ctx.actor.id }, select: { action: true, targetName: true, reason: true } });
    step('audit trail', audits);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining([
      AdminAuditAction.VEHICLE_IMAGE_APPROVED, AdminAuditAction.VEHICLE_IMAGE_REJECTED, AdminAuditAction.VEHICLE_IMAGE_UPLOADED,
    ]));
    const finalVehicles = await prisma.vehicle.findMany({
      where: { userId: { in: users }, deletedAt: null },
      select: { id: true, modelId: true, year: true, trimId: true, imageIdentity: { select: { status: true, imageUrl: true, catalogAssetKey: true } } },
    });
    report.final = finalVehicles;
    report.vehicleResponses = Object.fromEntries(await Promise.all(Object.entries(added).map(async ([k, v]) => [k, await view(owner, v.id)])));
    expect(finalVehicles.filter((v) => v.imageIdentity?.status === VehicleImageStatus.APPROVED).length).toBeGreaterThan(0);
  });
});

/** A synthetic transparent 1400x700 PNG (a flat shape), built without an image library. */
function syntheticTransparentPng(): Buffer {
  const width = 1400;
  const height = 700;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const inside = x > 120 && x < width - 120 && y > 220 && y < height - 60 &&
        !(y < 360 && (x < 420 || x > width - 380));
      const o = row + 1 + x * 4;
      if (inside) {
        raw[o] = 200;
        raw[o + 1] = 205;
        raw[o + 2] = 210;
        raw[o + 3] = 255;
      }
    }
  }
  const crc32 = (buf: Buffer) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** GET over HTTPS trusting the isolated environment's self-signed certificate only. */
function fetchSelfSigned(url: string) {
  const ca = readFileSync(process.env.VEHICLE_IMAGE_E2E_CA as string);
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    https.get(url, { ca }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'],
          cacheControl: res.headers['cache-control'],
          bytes: body.length,
          webp: body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP',
          width: body.length > 30 ? body.readUIntLE(24, 3) + 1 : null,
          height: body.length > 30 ? body.readUIntLE(27, 3) + 1 : null,
        });
      });
    }).on('error', reject);
  });
}
