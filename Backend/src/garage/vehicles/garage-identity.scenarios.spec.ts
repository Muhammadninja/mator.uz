/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unnecessary-type-assertion -- service responses and the in-memory Prisma stand-in are untyped by design */
/**
 * Garage "Brand → Model → Year → Add" end to end through the real services
 * (VehiclesService + VehicleImagesService + the vendored image registry) over an
 * in-memory database shaped like production (catalog rows from the 2026-11-13
 * snapshot). The pipeline is never called: the delivery stub only reports
 * whether the integration is on, and the queue only records kicks.
 */
import { BadRequestException } from '@nestjs/common';
import { VehicleImageStatus } from '@prisma/client';
import { VehiclesService } from './vehicles.service';
import { VehicleImagesService } from '../vehicle-images/vehicle-images.service';
import {
  catalog,
  fakePrisma,
  type Db,
} from '../../../test/utils/garage-fake-db';

/** A backend process over `db`: new instances = a restart. */
function boot(db: Db, pipelineEnabled = false) {
  const prisma = fakePrisma(db);
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const delivery = { enabled: pipelineEnabled, refresh: jest.fn() };
  const images = new VehicleImagesService(
    prisma,
    delivery as any,
    queue as any,
  );
  const garage = new VehiclesService(
    prisma,
    { emitGarageEvent: jest.fn() } as any,
    { emit: jest.fn() } as any,
    images,
  );
  return { garage, queue, delivery };
}

const add = (
  garage: VehiclesService,
  make_id: string,
  model_id: string,
  year: number,
  user = 'usr_1',
) => garage.create(user, { make_id, model_id, year } as any) as Promise<any>;

const VERIFIED = (modelId: string, generationId: string | null) => ({
  status: 'verified',
  reason: null,
  model_id: modelId,
  generation_id: generationId,
  facelift_id: null,
  market: 'UZ',
  year_basis: 'production',
});
const UNVERIFIED = (modelId: string) => ({
  status: 'unverified',
  reason: null,
  model_id: modelId,
  generation_id: null,
  facelift_id: null,
  market: null,
  year_basis: 'production',
});
const PENDING = { status: 'pending', stage: 'processing', url: null, version: null, reason: null };
const REVIEW = (reason: string) => ({
  status: 'needs_review',
  reason,
  model_id: null,
  generation_id: null,
  facelift_id: null,
  market: null,
  year_basis: 'production',
});
const CATALOG_IMAGE = (key: string) => ({
  status: 'approved',
  url: null,
  version: 1,
  catalog_asset_key: key,
  reason: null,
});
const PLACEHOLDER = (reason: string) => ({
  status: 'unavailable',
  url: null,
  version: null,
  reason,
});

describe.each([false, true])(
  'Garage add, pipeline integration %s',
  (pipelineEnabled) => {
    let db: Db;
    let app: ReturnType<typeof boot>;
    beforeEach(() => {
      db = catalog();
      app = boot(db, pipelineEnabled);
    });

    it('Cobalt, valid year → the approved Cobalt image, no pipeline request', async () => {
      const v = await add(app.garage, 'chevrolet', 'cobalt', 2020);
      expect(v.model).toEqual({ id: 'cobalt', name: 'Cobalt' });
      expect(v.identity).toEqual(VERIFIED('cobalt', 'cobalt-gen2'));
      expect(v.vehicle_image).toEqual(CATALOG_IMAGE('cobalt-gen2'));
      expect(db.outbox.size).toBe(0);
      expect(app.queue.add).not.toHaveBeenCalled();
    });

    it('Gentra, valid year → the approved Gentra image (and the verified 2020+ Lacetti alias)', async () => {
      const gentra = await add(app.garage, 'chevrolet', 'gentra', 2019);
      expect(gentra.identity).toEqual(VERIFIED('gentra', 'gentra'));
      expect(gentra.vehicle_image).toEqual(CATALOG_IMAGE('gentra'));
      const lacetti = await add(app.garage, 'chevrolet', 'lacetti', 2021);
      expect(lacetti.identity).toEqual(VERIFIED('lacetti', 'gentra'));
      expect(lacetti.vehicle_image).toEqual(CATALOG_IMAGE('gentra'));
      expect(db.outbox.size).toBe(0);
    });

    it('Nexia 2 vs Nexia 3: distinct identities from the year alone', async () => {
      const n2 = await add(app.garage, 'chevrolet', 'nexia', 2012);
      const n3 = await add(app.garage, 'chevrolet', 'nexia', 2018);
      // The vehicle keeps its catalog model (fitment); the identity is the generation.
      expect(n2.model.id).toBe('nexia');
      expect(n3.model.id).toBe('nexia');
      expect(n2.identity).toEqual(VERIFIED('nexia-2', 'nexia-2'));
      expect(n3.identity).toEqual(VERIFIED('nexia-3', 'nexia-3'));
      const k2 = db.vehicles.get(n2.id)!.imageIdentityKey;
      const k3 = db.vehicles.get(n3.id)!.imageIdentityKey;
      expect(k2).toMatch(/^[0-9a-f]{64}$/);
      expect(k3).toMatch(/^[0-9a-f]{64}$/);
      expect(k2).not.toBe(k3);
      expect(n3.vehicle_image).toEqual(CATALOG_IMAGE('nexia-r3'));
      // Nexia 2 has no approved image: placeholder, never the Nexia 3 picture.
      expect(n2.vehicle_image.status).not.toBe('approved');
      expect(n2.vehicle_image).toEqual(
        pipelineEnabled ? PENDING : PLACEHOLDER('not_requested'),
      );
      // The generation rows picked directly (the VIN flow) resolve the same way.
      const direct3 = await add(app.garage, 'chevrolet', 'nexia-3', 2018);
      expect(db.vehicles.get(direct3.id)!.imageIdentityKey).toBe(k3);
      expect(direct3.vehicle_image).toEqual(CATALOG_IMAGE('nexia-r3'));
    });

    it('Spark 2020 → no market is assumed: an unverified identity enters reviewed acquisition, never a US-market image', async () => {
      const v = await add(app.garage, 'chevrolet', 'spark', 2020);
      expect(v.identity).toEqual(UNVERIFIED('spark'));
      expect(v.vehicle_image).toEqual(pipelineEnabled ? PENDING : PLACEHOLDER('not_requested'));
      const [stored] = [...db.identities.values()];
      expect(stored.identity).toMatchObject({ modelId: 'spark', identityStatus: 'unverified' });
      expect(stored.identity).not.toHaveProperty('marketRegion');
      expect(db.outbox.size).toBe(pipelineEnabled ? 1 : 0);
      expect(app.queue.add).toHaveBeenCalledTimes(pipelineEnabled ? 1 : 0);
    });

    it('Tracker 2022 → two catalog models share the name: each keeps its own identity, no image guessed', async () => {
      const keys = new Set<string>();
      for (const id of ['tracker', 'tracker-2']) {
        const v = await add(app.garage, 'chevrolet', id, 2022);
        expect(v.model).toEqual({ id, name: 'Tracker' });
        expect(v.identity).toEqual(UNVERIFIED(id));
        expect(v.vehicle_image.status).not.toBe('approved');
        keys.add(db.vehicles.get(v.id)!.imageIdentityKey as string);
      }
      expect(keys.size).toBe(2);
      expect(db.outbox.size).toBe(pipelineEnabled ? 2 : 0);
    });

    it('Unsupported model/year → VEHICLE_YEAR_UNSUPPORTED, nothing saved', async () => {
      const cases: [string, number, number | null, number][] = [
        ['nexia', 2023, 1996, 2022],
        ['nexia-3', 2015, 2016, 2022],
        ['nexia-2', 2017, 2008, 2016],
        ['cobalt', 2030, null, 2027],
      ];
      for (const [id, year, from, to] of cases) {
        const err = await add(app.garage, 'chevrolet', id, year).catch(
          (e) => e,
        );
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.getResponse()).toMatchObject({
          code: 'VEHICLE_YEAR_UNSUPPORTED',
          details: { year, year_from: from, year_to: to },
        });
      }
      const mismatch = await add(
        app.garage,
        'volkswagen',
        'cobalt',
        2020,
      ).catch((e) => e);
      expect(mismatch).toBeInstanceOf(BadRequestException);
      expect(db.vehicles.size).toBe(0);
    });

    it('Ambiguous generation (Nexia 2016) → needs_review, no AI request; the owner pick resolves it', async () => {
      const v = await add(app.garage, 'chevrolet', 'nexia', 2016);
      expect(v.generation.status).toBe('choice_required');
      expect(v.identity).toEqual(REVIEW('generation_unresolved'));
      expect(v.vehicle_image).toEqual(PLACEHOLDER('needs_review'));
      expect(db.identities.size).toBe(0);
      expect(db.outbox.size).toBe(0);
      expect(app.queue.add).not.toHaveBeenCalled();

      const picked: any = await app.garage.update('usr_1', v.id, {
        variant_model_id: 'nexia-3',
      });
      expect(picked.identity).toEqual(VERIFIED('nexia-3', 'nexia-3'));
      expect(picked.vehicle_image).toEqual(CATALOG_IMAGE('nexia-r3'));
      expect(db.outbox.size).toBe(0);
    });

    it('Existing approved asset → reused, never generated again', async () => {
      // Registry image: the second owner gets the same identity, no request.
      const a = await add(app.garage, 'chevrolet', 'cobalt', 2020, 'usr_1');
      const b = await add(app.garage, 'chevrolet', 'cobalt', 2020, 'usr_2');
      expect(db.vehicles.get(b.id)!.imageIdentityKey).toBe(
        db.vehicles.get(a.id)!.imageIdentityKey,
      );
      expect(db.identities.size).toBe(1);

      // A pipeline publication already approved for a market-aware identity.
      const first = await add(app.garage, 'chevrolet', 'nexia', 2012, 'usr_1');
      const key = db.vehicles.get(first.id)!.imageIdentityKey;
      Object.assign(db.identities.get(key)!, {
        status: VehicleImageStatus.APPROVED,
        reason: null,
        imageUrl: 'https://res.cloudinary.com/mator/nexia2-v1.webp',
        imageVersion: 1,
        lastSyncedAt: new Date(),
      });
      const outboxBefore = db.outbox.size;
      const kicksBefore = app.queue.add.mock.calls.length;
      const again = await add(app.garage, 'chevrolet', 'nexia', 2012, 'usr_2');
      expect(again.vehicle_image).toEqual({
        status: 'approved',
        url: 'https://res.cloudinary.com/mator/nexia2-v1.webp',
        version: 1,
        reason: null,
      });
      expect(db.outbox.size).toBe(outboxBefore);
      expect(app.queue.add.mock.calls.length).toBe(kicksBefore);
    });

    it('a model of another make with no registry entry (VW Polo) enters the pipeline without any code change', async () => {
      const v = await add(app.garage, 'volkswagen', 'polo', 2021);
      expect(v.identity).toEqual(UNVERIFIED('polo'));
      expect(v.vehicle_image).toEqual(pipelineEnabled ? PENDING : PLACEHOLDER('not_requested'));
      expect(db.outbox.size).toBe(pipelineEnabled ? 1 : 0);
    });

    it('Restart / re-login → the same vehicle, identity and image; a later catalog edit reassigns nothing', async () => {
      const added = [
        await add(app.garage, 'chevrolet', 'cobalt', 2020),
        await add(app.garage, 'chevrolet', 'nexia', 2012),
        await add(app.garage, 'chevrolet', 'nexia', 2018),
        await add(app.garage, 'chevrolet', 'spark', 2020),
      ];
      const pick = (v: any) => ({
        id: v.id,
        make: v.make.id,
        model: v.model.id,
        year: v.year,
        identity: v.identity,
        vehicle_image: v.vehicle_image,
      });

      // Backend restart + the app reading its garage again after logout/login.
      const restarted = boot(db, pipelineEnabled);
      const listed = await restarted.garage.list('usr_1', {
        includeDeleted: false,
        include3d: true,
      });
      const byId = new Map(listed.vehicles.map((v: any) => [v.id, v]));
      for (const v of added) expect(pick(byId.get(v.id))).toEqual(pick(v));

      // The catalog is edited later: saved identities do not move.
      Object.assign(db.models.get('nexia-2')!, { yearFrom: 2013 });
      Object.assign(db.models.get('nexia-3')!, { yearFrom: 2011 });
      const again = await boot(db, pipelineEnabled).garage.list('usr_1', {
        includeDeleted: false,
        include3d: true,
      });
      const after = new Map(again.vehicles.map((v: any) => [v.id, v]));
      for (const v of added) {
        expect((after.get(v.id) as any).identity).toEqual(v.identity);
        expect((after.get(v.id) as any).vehicle_image).toEqual(v.vehicle_image);
      }
    });
  },
);

describe('Garage add with the pipeline on: one request per identity', () => {
  it('a verified identity without an approved image is requested once, however many owners add it', async () => {
    const db = catalog();
    const app = boot(db, true);
    await add(app.garage, 'chevrolet', 'nexia', 2012, 'usr_1');
    await add(app.garage, 'chevrolet', 'nexia', 2013, 'usr_2'); // another year: another identity
    await add(app.garage, 'chevrolet', 'nexia', 2012, 'usr_3');
    expect(db.identities.size).toBe(2);
    expect(db.outbox.size).toBe(2);
    expect(app.queue.add).toHaveBeenCalledTimes(2);
  });

  it('switching the pipeline on later asks once for identities saved while it was off', async () => {
    const db = catalog();
    const off = boot(db, false);
    const first = await add(off.garage, 'chevrolet', 'nexia', 2012);
    expect(first.vehicle_image).toEqual(PLACEHOLDER('not_requested'));
    expect(db.outbox.size).toBe(0);
    const on = boot(db, true);
    const second = await add(on.garage, 'chevrolet', 'nexia', 2012, 'usr_2');
    expect(second.vehicle_image.status).toBe('pending');
    expect(db.outbox.size).toBe(1);
    // The first owner's vehicle shares the identity and now reads pending too.
    const relisted = await on.garage.list('usr_1', {
      includeDeleted: false,
      include3d: true,
    });
    expect(relisted.vehicles[0].vehicle_image.status).toBe('pending');
  });
});
