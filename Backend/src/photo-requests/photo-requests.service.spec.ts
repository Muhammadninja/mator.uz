import { NotificationType, PhotoRequestStatus } from '@prisma/client';

import { PhotoRequestsService } from './photo-requests.service';

function build(part: { id: string; title: string; images: string[] } | null) {
  const prisma = {
    catalogPart: { findUnique: jest.fn(async () => part) },
    photoRequest: {
      findUnique: jest.fn(async (): Promise<any> => null),
      upsert: jest.fn(async () => ({ id: 'pr1' })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async () => ({})),
      count: jest.fn(async () => 2),
      findMany: jest.fn(async () => []),
    },
    $queryRaw: jest.fn(async (): Promise<any[]> => []),
  };
  const telegram = { sendPhotoRequest: jest.fn(async () => ({ ok: true })) };
  const notifications = { emit: jest.fn(async () => ({})) };
  const service = new PhotoRequestsService(prisma as never, telegram as never, notifications as never);
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  return { service, prisma, telegram, notifications };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

describe('PhotoRequestsService.request', () => {
  it('records a request for a part with no photo and tells staff', async () => {
    const { service, prisma, telegram } = build({ id: 'p1', title: 'Seal', images: [] });
    prisma.photoRequest.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ partId: 'p1', partTitle: 'Seal' });
    const outcome = await service.request('u1', 'p1');
    expect(outcome).toEqual({ kind: 'REQUESTED', partId: 'p1', partTitle: 'Seal' });
    expect(prisma.photoRequest.upsert).toHaveBeenCalled();
    await flush();
    expect(telegram.sendPhotoRequest).toHaveBeenCalledWith({
      partId: 'p1',
      partTitle: 'Seal',
      waiting: 2,
    });
  });

  it('does not repeat an open request', async () => {
    const { service, prisma, telegram } = build({ id: 'p1', title: 'Seal', images: [] });
    prisma.photoRequest.findUnique.mockResolvedValueOnce({ status: PhotoRequestStatus.PENDING });
    expect((await service.request('u1', 'p1')).kind).toBe('REQUESTED');
    expect(prisma.photoRequest.upsert).not.toHaveBeenCalled();
    await flush();
    expect(telegram.sendPhotoRequest).not.toHaveBeenCalled();
  });

  it('records nothing when the part already shows a photo', async () => {
    const { service, prisma } = build({ id: 'p1', title: 'Seal', images: ['https://x/1.jpg'] });
    expect((await service.request('u1', 'p1')).kind).toBe('ALREADY_AVAILABLE');
    expect(prisma.photoRequest.upsert).not.toHaveBeenCalled();
  });

  it('reports an unknown part', async () => {
    const { service } = build(null);
    expect(await service.request('u1', 'nope')).toEqual({ kind: 'NOT_FOUND' });
  });
});

describe('PhotoRequestsService.fulfilReady', () => {
  it('notifies the customer in their language with a link to the part', async () => {
    const { service, prisma, notifications } = build(null);
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'pr1' }]);
    prisma.photoRequest.findUnique.mockResolvedValueOnce({
      userId: 'u1',
      partId: 'p1',
      partTitle: 'Seal',
      user: { language: 'RU' },
    });
    await service.fulfilReady();
    expect(prisma.photoRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FULFILLED' }) }),
    );
    expect(notifications.emit).toHaveBeenCalledWith('u1', {
      type: NotificationType.PRODUCT_PHOTO_ADDED,
      title: 'Фото добавлено',
      body: 'Появилось фото товара: Seal.',
      data: { photoRequestId: 'pr1', partId: 'p1', partName: 'Seal' },
      deeplinkPath: '/item-detail/p1',
    });
  });

  it('reopens the request when the notification fails, so it is retried', async () => {
    const { service, prisma, notifications } = build(null);
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'pr1' }]);
    prisma.photoRequest.findUnique.mockResolvedValueOnce({
      userId: 'u1',
      partId: 'p1',
      partTitle: 'Seal',
      user: { language: 'UZ' },
    });
    notifications.emit.mockRejectedValueOnce(new Error('db down'));
    await service.fulfilReady();
    expect(prisma.photoRequest.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'pr1', status: PhotoRequestStatus.FULFILLED },
      data: { status: PhotoRequestStatus.PENDING, fulfilledAt: null },
    });
  });

  it('skips a request another sweep already claimed', async () => {
    const { service, prisma, notifications } = build(null);
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'pr1' }]);
    prisma.photoRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    await service.fulfilReady();
    expect(notifications.emit).not.toHaveBeenCalled();
  });
});
