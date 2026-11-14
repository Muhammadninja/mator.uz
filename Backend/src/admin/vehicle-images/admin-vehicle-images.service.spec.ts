/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- mocked collaborators are untyped */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminAuditAction, AdminAuditEntity } from '@prisma/client';
import { AdminVehicleImagesService } from './admin-vehicle-images.service';

const CANDIDATE = '11111111-2222-4333-8444-555555555555';
const REQUEST = '99999999-8888-4777-8666-555555555555';
const actor = { id: 'adm_1', email: 'manager@mator.test', name: 'Manager' };
const ctx = { actor, ip: '127.0.0.1', userAgent: 'jest' };

const entry = (over: Record<string, unknown> = {}) => ({
  requestId: REQUEST,
  identityKey: 'a'.repeat(64),
  subjectKey: 'identity:aaa',
  identity: { makeId: 'chevrolet', modelId: 'spark', modelYear: 2019, identityStatus: 'unverified' },
  vehicle: { manufacturer: 'Chevrolet', model: 'Spark', year: 2019 },
  verification: 'unverified',
  status: 'awaiting_approval',
  identityReviewRequired: false,
  job: null,
  candidates: [{ id: CANDIDATE, status: 'pending' }],
  members: [{ identityKey: 'b'.repeat(64), year: 2020 }],
  publication: null,
  createdAt: '2026-11-14T00:00:00.000Z',
  ...over,
});

function setup() {
  const prisma: any = {
    vehicle: { groupBy: jest.fn().mockResolvedValue([{ imageIdentityKey: 'a'.repeat(64), _count: { _all: 3 } }]) },
    vehicleImageIdentity: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([{ identityKey: 'c'.repeat(64) }]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    vehicleImageOutbox: { groupBy: jest.fn().mockResolvedValue([{ status: 'DEAD', _count: { _all: 2 } }]) },
    adminAudit: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const pipeline: any = {
    available: true,
    reviewQueue: jest.fn().mockResolvedValue([entry()]),
    approve: jest.fn().mockResolvedValue({ id: CANDIDATE, status: 'approved' }),
    reject: jest.fn().mockResolvedValue({ id: CANDIDATE, status: 'rejected' }),
    retry: jest.fn().mockResolvedValue({ id: 'job-1', status: 'queued' }),
    upload: jest.fn().mockResolvedValue({ id: CANDIDATE, contentSha256: 'f'.repeat(64) }),
    metrics: jest.fn().mockResolvedValue({ reviewQueue: 4 }),
    history: jest.fn().mockResolvedValue({ identityKey: 'a'.repeat(64) }),
    preview: jest.fn(),
  };
  const delivery: any = {
    enabled: true,
    syncNow: jest.fn().mockResolvedValue(true),
    health: jest.fn().mockResolvedValue({
      ready: false, error: 'network:ECONNREFUSED', registryMatches: false, registrySha256: null,
      contract: null, capabilities: null, checkedAt: new Date(),
    }),
  };
  const reconcile: any = {
    run: jest.fn().mockResolvedValue({ runId: 'rec_1', apply: true, scanned: 5, upgraded: 2, conflicts: 0, stamp: 's', changes: [] }),
    revert: jest.fn().mockResolvedValue({ runId: 'rec_1', logged: 2, reverted: 2, skipped: 0 }),
  };
  const audit: any = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new AdminVehicleImagesService(prisma, pipeline, delivery, reconcile, audit);
  return { svc, prisma, pipeline, delivery, reconcile, audit };
}

describe('AdminVehicleImagesService', () => {
  it('approves under the administrator, audits it, and re-reads the affected Garage identities', async () => {
    const { svc, pipeline, audit, delivery } = setup();
    const confirmation = { confirmed: true as const, reference: 'chevrolet.uz Spark page' };
    const result = await svc.approve(CANDIDATE, { identityConfirmation: confirmation }, ctx);
    expect(pipeline.approve).toHaveBeenCalledWith(CANDIDATE, { actor, identityConfirmation: confirmation });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: AdminAuditAction.VEHICLE_IMAGE_APPROVED,
      actor,
      target: { entity: AdminAuditEntity.VEHICLE_IMAGE, id: REQUEST, name: 'Chevrolet Spark 2019' },
      newValues: expect.objectContaining({ candidateId: CANDIDATE, identityConfirmation: confirmation, verification: 'unverified' }),
    }));
    expect(delivery.syncNow.mock.calls.map((c: string[]) => c[0]).sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(result.syncedIdentities).toBe(2);
  });

  it('a scoped approval also re-reads every identity of the same model', async () => {
    const { svc, prisma, delivery } = setup();
    await svc.approve(CANDIDATE, { identityConfirmation: { confirmed: true, reference: 'checked' }, scope: { yearFrom: 2016, yearTo: 2022 } }, ctx);
    expect(prisma.vehicleImageIdentity.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { identity: { path: ['modelId'], equals: 'spark' } },
    }));
    expect(delivery.syncNow).toHaveBeenCalledWith('c'.repeat(64));
  });

  it('refuses a decision on a candidate that is not pending any more, before calling the pipeline', async () => {
    const { svc, pipeline, audit } = setup();
    pipeline.reviewQueue.mockResolvedValue([entry({ candidates: [{ id: CANDIDATE, status: 'rejected' }] })]);
    await expect(svc.approve(CANDIDATE, {}, ctx)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.reject(CANDIDATE, 'x', ctx)).rejects.toBeInstanceOf(NotFoundException);
    expect(pipeline.approve).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('nothing is audited when the pipeline refuses the decision', async () => {
    const { svc, pipeline, audit } = setup();
    pipeline.approve.mockRejectedValue(Object.assign(new Error('identity confirmation is required'), { status: 409 }));
    await expect(svc.approve(CANDIDATE, {}, ctx)).rejects.toThrow(/identity confirmation/);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects with the reason in the audit trail', async () => {
    const { svc, pipeline, audit } = setup();
    await svc.reject(CANDIDATE, 'roof rails differ', ctx);
    expect(pipeline.reject).toHaveBeenCalledWith(CANDIDATE, { actor, reason: 'roof rails differ' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: AdminAuditAction.VEHICLE_IMAGE_REJECTED, reason: 'roof rails differ',
    }));
  });

  it('uploads only real images within the size limit and never audits image data', async () => {
    const { svc, pipeline, audit } = setup();
    await expect(svc.upload(REQUEST, undefined, ctx)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.upload(REQUEST, { buffer: Buffer.from('x'), mimetype: 'image/gif', size: 1 }, ctx))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.upload(REQUEST, { buffer: Buffer.alloc(10), mimetype: 'image/png', size: 9 * 1024 * 1024 }, ctx))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(pipeline.upload).not.toHaveBeenCalled();
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    await svc.upload(REQUEST, { buffer: png, mimetype: 'image/png', size: png.length }, ctx);
    expect(pipeline.upload).toHaveBeenCalledWith(REQUEST, { contentType: 'image/png', data: png.toString('base64'), actor });
    const audited = JSON.stringify(audit.record.mock.calls[0][0]);
    expect(audited).not.toContain(png.toString('base64'));
    expect(audited).toContain('f'.repeat(64));
  });

  it('reports coverage, the registry handshake and actionable problems', async () => {
    const { svc, prisma } = setup();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { state: 'approved_registry_image', count: 3n },
        { state: 'awaiting_review', count: 1n },
        { state: 'unresolved', count: 4n },
      ])
      .mockResolvedValueOnce([{ kind: 'verified', count: 2n }, { kind: 'unverified', count: 5n }]);
    const status = await svc.status();
    expect(status.garage).toEqual({
      liveVehicles: 8,
      withVerifiedImage: 3,
      coveragePercent: 37.5,
      byState: { approved_registry_image: 3, awaiting_review: 1, unresolved: 4 },
    });
    expect(status.identityKinds).toEqual({ verified: 2, unverified: 5 });
    expect(status.registry.matches).toBe(false);
    expect(status.outbox).toEqual({ DEAD: 2 });
    expect(status.actions.join('\n')).toMatch(/not usable \(network:ECONNREFUSED\)/);
    expect(status.actions.join('\n')).toMatch(/2 requests never reached/);
    expect(status.actions.join('\n')).toMatch(/4 candidate images wait/);
  });

  it('the queue puts work waiting on a person first and counts the Garage vehicles behind it', async () => {
    const { svc, pipeline } = setup();
    pipeline.reviewQueue.mockResolvedValue([
      entry({ requestId: 'r-approved', status: 'approved', identityKey: 'd'.repeat(64), members: [] }),
      entry(),
    ]);
    const queue = await svc.queue();
    expect(queue.map((e) => e.status)).toEqual(['awaiting_approval', 'approved']);
    expect(queue[0].garageVehicles).toBe(3);
  });

  it('a reconcile run is a dry run unless asked, and an applied one is audited', async () => {
    const { svc, reconcile, audit } = setup();
    await svc.reconcileRun({}, ctx);
    expect(reconcile.run).toHaveBeenCalledWith(expect.objectContaining({ apply: false }));
    reconcile.run.mockResolvedValueOnce({ runId: 'rec_2', apply: true, scanned: 1, upgraded: 1, conflicts: 0, stamp: 's', changes: [] });
    await svc.reconcileRun({ apply: true }, ctx);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: AdminAuditAction.VEHICLE_IMAGE_RECONCILED,
      target: expect.objectContaining({ id: 'rec_2' }),
    }));
  });
});
