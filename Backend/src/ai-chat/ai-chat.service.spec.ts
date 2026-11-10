import { ConflictException, HttpException } from '@nestjs/common';
import { AiChatService } from './ai-chat.service';
import { SourcingLeaseLostError } from '../sourcing/sourcing-request.service';

const ITEM = { id: 'p1', title: 'Фильтр', price: '50 000 сум', category: null, categoryId: null, fit: null };
const VEHICLE = {
  id: 'v1',
  vin: 'XUFCB6950K0000017',
  modelId: 'model_cobalt',
  trimId: null,
  engineId: null,
  year: 2020,
  make: { name: 'Chevrolet' },
  model: { name: 'Cobalt' },
};

interface Setup {
  model?: Record<string, unknown>;
  ticketsEnabled?: boolean;
  found?: boolean;
  vehicle?: unknown;
}

function part(part_name: string, clarification_question: string | null = null) {
  return { part_name, clarification_question };
}

function build({ model = {}, ticketsEnabled = true, found = false, vehicle = null }: Setup = {}) {
  const create = jest.fn(async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          reply_text: 'model text',
          intent: 'SEARCH_PART',
          extracted_data: { part_name: 'радиатор' },
          parts: [part('радиатор')],
          all_parts_accounted: true,
          ...model,
        }),
      },
    ],
  }));
  const rag = {
    searchInStock: jest.fn(async () =>
      found ? { found: true, items: [ITEM] } : { found: false, items: [] },
    ),
  };
  const sourcing = { findOpenDuplicate: jest.fn(async () => null as unknown) };
  const adminEvents = { notifyAdminsNewTicket: jest.fn() };
  const prisma = { vehicle: { findFirst: jest.fn(async () => vehicle) } };
  const requests = {
    claim: jest.fn(async () => ({ kind: 'owner', requestId: 'r1', leaseToken: 'l1' }) as any),
    commit: jest.fn(async ({ items }: any) => items),
    release: jest.fn(async () => undefined),
  };
  const lifecycle = { dispatchStaffNotification: jest.fn(async () => undefined) };
  const config = {
    ticketsEnabled,
    duplicateWindowMs: 3_600_000,
    llmTimeoutMs: 18_000,
  };
  const service = new AiChatService(
    { get: () => 'test-key' } as never,
    rag as never,
    sourcing as never,
    adminEvents as never,
    prisma as never,
    requests as never,
    lifecycle as never,
    config as never,
  );
  (service as any).client = { messages: { create } };
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
  return { service, create, rag, sourcing, adminEvents, prisma, requests, lifecycle };
}

const guest = { userId: null, idempotencyKey: null, selectedVehicleId: null };
const signedIn = { userId: 'u1', idempotencyKey: 'key-00000001', selectedVehicleId: null };
const message = { message: 'нужен радиатор' } as never;

describe('guests', () => {
  it('cannot create a ticket or notify staff', async () => {
    const { service, requests, lifecycle, adminEvents } = build();
    const reply = await service.processUserMessage(message, guest);
    expect(reply.intent).toBe('SOURCING_AUTH_REQUIRED');
    expect(reply.parts).toEqual([{ part_name: 'радиатор', status: 'AUTH_REQUIRED' }]);
    expect(reply.ticket_id).toBeUndefined();
    expect(requests.commit).not.toHaveBeenCalled();
    expect(lifecycle.dispatchStaffNotification).not.toHaveBeenCalled();
    expect(adminEvents.notifyAdminsNewTicket).not.toHaveBeenCalled();
  });

  it('never touch the request store, so a key cannot collide with an account', async () => {
    const { service, requests } = build();
    await service.processUserMessage(message, { ...guest, idempotencyKey: 'key-00000001' });
    expect(requests.claim).not.toHaveBeenCalled();
  });

  it('can still see catalogue matches', async () => {
    const { service } = build({ found: true });
    const reply = await service.processUserMessage(message, guest);
    expect(reply.intent).toBe('FOUND_IN_STOCK');
    expect(reply.items).toEqual([ITEM]);
  });

  it('cannot use a selected vehicle', async () => {
    const { service, prisma } = build();
    await service.processUserMessage(message, { ...guest, selectedVehicleId: 'v1' });
    expect(prisma.vehicle.findFirst).not.toHaveBeenCalled();
  });
});

describe('the ticket switch', () => {
  it.each([
    ['signed in', signedIn],
    ['guest', guest],
  ])('off: %s gets no ticket and no sign-in prompt', async (_name, context) => {
    const { service, requests } = build({ ticketsEnabled: false });
    const reply = await service.processUserMessage(message, context);
    expect(reply.intent).toBe('SOURCING_UNAVAILABLE');
    expect(reply.parts[0].status).toBe('UNAVAILABLE');
    expect(requests.commit).not.toHaveBeenCalled();
  });
});

describe('a signed-in request', () => {
  it('returns the id of the ticket it committed, and notifies staff', async () => {
    const { service, requests, lifecycle } = build();
    const reply = await service.processUserMessage(message, signedIn);
    const item = requests.commit.mock.calls[0][0].items[0];
    expect(reply.intent).toBe('CREATE_SOURCING_TICKET');
    expect(reply.ticket_id).toBe(item.id);
    expect(reply.reply_text).toContain('Заявка принята');
    expect(lifecycle.dispatchStaffNotification).toHaveBeenCalledWith(item.id);
  });

  it('stores the same result it returns, for retries to replay', async () => {
    const { service, requests } = build();
    const reply = await service.processUserMessage(message, signedIn);
    expect(requests.commit.mock.calls[0][0].response).toEqual(reply);
  });

  it('a failed Telegram send does not fail the customer', async () => {
    const { service, lifecycle } = build();
    lifecycle.dispatchStaffNotification.mockRejectedValue(new Error('telegram down'));
    await expect(service.processUserMessage(message, signedIn)).resolves.toMatchObject({
      intent: 'CREATE_SOURCING_TICKET',
    });
  });
});

describe('request ids', () => {
  it('a retry gets the original result, without calling the model', async () => {
    const original = { intent: 'CREATE_SOURCING_TICKET', ticket_id: 't-original' };
    const { service, requests, create } = build();
    requests.claim.mockResolvedValue({ kind: 'replay', response: original });
    await expect(service.processUserMessage(message, signedIn)).resolves.toEqual(original);
    expect(create).not.toHaveBeenCalled();
    expect(requests.commit).not.toHaveBeenCalled();
  });

  it('reuse with a different payload is passed on as a conflict', async () => {
    const { service, requests } = build();
    const conflict = new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'x' });
    requests.claim.mockRejectedValue(conflict);
    await expect(service.processUserMessage(message, signedIn)).rejects.toBe(conflict);
  });

  it('a model failure frees the id and reports 503 with no ticket', async () => {
    const { service, create, requests } = build();
    create.mockRejectedValue(new Error('anthropic down'));
    await expect(service.processUserMessage(message, signedIn)).rejects.toMatchObject({
      status: 503,
    });
    expect(requests.release).toHaveBeenCalled();
    expect(requests.commit).not.toHaveBeenCalled();
  });

  it('a database failure on commit frees the id and notifies nobody', async () => {
    const { service, requests, lifecycle } = build();
    requests.commit.mockRejectedValue(new Error('db down'));
    await expect(service.processUserMessage(message, signedIn)).rejects.toBeInstanceOf(HttpException);
    expect(requests.release).toHaveBeenCalled();
    expect(lifecycle.dispatchStaffNotification).not.toHaveBeenCalled();
  });

  it('losing the lease returns the other worker’s result', async () => {
    const { service, requests } = build();
    requests.commit.mockRejectedValueOnce(new SourcingLeaseLostError());
    requests.claim
      .mockResolvedValueOnce({ kind: 'owner', requestId: 'r1', leaseToken: 'l1' })
      .mockResolvedValueOnce({ kind: 'replay', response: { ticket_id: 'winner' } });
    await expect(service.processUserMessage(message, signedIn)).resolves.toEqual({
      ticket_id: 'winner',
    });
    expect(requests.release).not.toHaveBeenCalled();
  });

  it('a reply with no ticket frees the id, so regenerating gets a new answer', async () => {
    const { service, requests } = build({ found: true });
    await service.processUserMessage(message, signedIn);
    expect(requests.release).toHaveBeenCalled();
  });
});

describe('vehicle context', () => {
  it('uses the caller’s own vehicle for matching and the ticket', async () => {
    const { service, prisma, rag, requests } = build({ vehicle: VEHICLE });
    const reply = await service.processUserMessage(message, { ...signedIn, selectedVehicleId: 'v1' });
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'v1', userId: 'u1', deletedAt: null },
      }),
    );
    expect((rag.searchInStock.mock.calls[0] as any)[0].vehicle).toMatchObject({
      modelId: 'model_cobalt',
      year: 2020,
    });
    expect(requests.commit.mock.calls[0][0].items[0]).toMatchObject({
      vehicleId: 'v1',
      vehicleKey: 'vehicle:v1',
    });
    expect(reply.selected_vehicle).toEqual({ id: 'v1', label: 'Chevrolet Cobalt 2020' });
  });

  it('ignores a vehicle that is not the caller’s', async () => {
    const { service, rag, requests } = build({ vehicle: null });
    const reply = await service.processUserMessage(message, { ...signedIn, selectedVehicleId: 'other' });
    expect((rag.searchInStock.mock.calls[0] as any)[0].vehicle).toBeUndefined();
    expect(requests.commit.mock.calls[0][0].items[0].vehicleId).toBeNull();
    expect(reply.selected_vehicle).toBeNull();
  });

  it('a car named in the message wins over the selected one', async () => {
    const { service, rag, requests } = build({
      vehicle: VEHICLE,
      model: { extracted_data: { brand: 'Kia', model: 'K5', part_name: 'радиатор' } },
    });
    await service.processUserMessage(message, { ...signedIn, selectedVehicleId: 'v1' });
    expect((rag.searchInStock.mock.calls[0] as any)[0].vehicle).toBeUndefined();
    const item = requests.commit.mock.calls[0][0].items[0];
    expect(item.vehicleId).toBeNull();
    expect(item.vehicleKey).toContain('kia');
  });

  it('never sends the selected vehicle’s VIN to the model', async () => {
    const { service, create } = build({ vehicle: VEHICLE });
    await service.processUserMessage(message, { ...signedIn, selectedVehicleId: 'v1' });
    expect(JSON.stringify((create.mock.calls[0] as any)[0].messages)).not.toContain(VEHICLE.vin);
  });
});

describe('duplicates', () => {
  it('asking again for an open request returns it, with no new ticket or staff message', async () => {
    const { service, sourcing, requests, lifecycle } = build();
    sourcing.findOpenDuplicate.mockResolvedValue({ id: 'existing' });
    const reply = await service.processUserMessage(message, signedIn);
    expect(reply.ticket_id).toBe('existing');
    expect(requests.commit.mock.calls[0][0].items).toEqual([]);
    expect(lifecycle.dispatchStaffNotification).not.toHaveBeenCalled();
  });

  it('checks by account, part and car', async () => {
    const { service, sourcing } = build({ vehicle: VEHICLE });
    await service.processUserMessage(message, { ...signedIn, selectedVehicleId: 'v1' });
    expect(sourcing.findOpenDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', vehicleKey: 'vehicle:v1' }),
    );
  });
});

describe('several parts', () => {
  const twoParts = {
    intent: 'SEARCH_PART',
    extracted_data: { part_name: 'салонный фильтр' },
    parts: [part('салонный фильтр'), part('радиатор')],
    all_parts_accounted: true,
  };

  it('gives each part its own outcome and ticket', async () => {
    const { service, rag, requests } = build({ model: twoParts });
    rag.searchInStock
      .mockResolvedValueOnce({ found: true, items: [ITEM] } as never)
      .mockResolvedValueOnce({ found: false, items: [] });
    const reply = await service.processUserMessage(message, signedIn);
    expect(reply.intent).toBe('PARTS_RESULT');
    expect(reply.parts.map((p) => p.status)).toEqual(['FOUND_IN_STOCK', 'TICKET_CREATED']);
    expect(requests.commit.mock.calls[0][0].items.map((i: any) => i.partName)).toEqual(['радиатор']);
  });

  it('asks about an ambiguous part, and still handles the others', async () => {
    const { service, requests, rag } = build({
      model: {
        ...twoParts,
        parts: [part('амортизатор', 'Передний или задний?'), part('радиатор')],
      },
    });
    const reply = await service.processUserMessage(message, signedIn);
    expect(reply.reply_text).toBe('Передний или задний?');
    expect(reply.parts.map((p) => p.status)).toEqual(['NEEDS_CLARIFICATION', 'TICKET_CREATED']);
    expect(requests.commit.mock.calls[0][0].items).toHaveLength(1);
    expect(rag.searchInStock).toHaveBeenCalledTimes(1);
  });

  it('the same part listed twice makes one ticket, and neither is dropped', async () => {
    const { service, requests } = build({
      model: { ...twoParts, parts: [part('радиатор'), part('Радиатор')] },
    });
    const reply = await service.processUserMessage(message, signedIn);
    expect(reply.parts).toHaveLength(2);
    expect(requests.commit.mock.calls[0][0].items).toHaveLength(1);
    expect(reply.parts[0].ticket_id).toBe(reply.parts[1].ticket_id);
  });

  it('says so when the model is unsure it covered everything', async () => {
    const { service } = build({ model: { ...twoParts, all_parts_accounted: false } });
    const reply = await service.processUserMessage(message, signedIn);
    expect(reply.all_parts_accounted).toBe(false);
  });

  it('a reply with only the old single field cannot claim to be complete', async () => {
    const { service } = build({
      model: { parts: undefined, all_parts_accounted: undefined, extracted_data: { part_name: 'радиатор' } },
    });
    const reply = await service.processUserMessage(message, signedIn);
    expect(reply.parts).toHaveLength(1);
    expect(reply.all_parts_accounted).toBe(false);
  });
});

describe('promises', () => {
  it('a general reply making a promise is replaced', async () => {
    const { service } = build({
      model: {
        intent: 'GENERAL_QUESTION',
        parts: [],
        extracted_data: {},
        reply_text: 'Наш отдел закупок ответит в течение 15 минут.',
      },
    });
    const reply = await service.processUserMessage(message, guest);
    expect(reply.reply_text).toBe('Какая запчасть вам нужна?');
  });

  it('instructions to the model no longer ask for one', async () => {
    const { service, create } = build();
    await service.processUserMessage(message, guest);
    const { system } = (create.mock.calls[0] as any)[0];
    expect(system).not.toContain('within 15 minutes');
    expect(system).toContain('NEVER promise a response time');
  });
});

describe('language', () => {
  it('a one-word reply stays in the conversation’s language', async () => {
    const { service } = build();
    const reply = await service.processUserMessage(
      { message: 'Salon', history: [{ role: 'user', content: 'Moy filter kerak' }] } as never,
      signedIn,
    );
    expect(reply.reply_text).toContain('qabul qilindi');
  });
});

describe('no usage limits (SEC-009)', () => {
  it('answers a guest without touching Redis or any counter', async () => {
    const { service, create } = build();
    const reply = await service.processUserMessage(message, guest);
    expect(create).toHaveBeenCalledTimes(1);
    expect(reply.reply_text).toEqual(expect.any(String));
  });

  it('answers a signed-in buyer the same way', async () => {
    const { service, create } = build();
    await service.processUserMessage(message, signedIn);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('replays a full 20,000-character history to the model', async () => {
    const { service, create } = build();
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: 'x'.repeat(2000),
    }));
    await service.processUserMessage({ message: 'нужен радиатор', history } as never, guest);
    const sent = (create.mock.calls[0] as any)[0].messages as { content: string }[];
    expect(sent.reduce((n, m) => n + m.content.length, 0)).toBeGreaterThanOrEqual(20_000);
  });

  it('a provider failure is a 503', async () => {
    const { service, create } = build();
    create.mockRejectedValue(new Error('provider down'));
    await expect(service.processUserMessage(message, guest)).rejects.toMatchObject({ status: 503 });
  });

  it('a lost lease is retried once, and then given up on', async () => {
    const { service, create, requests } = build();
    requests.commit.mockRejectedValue(new SourcingLeaseLostError());
    await expect(service.processUserMessage(message, signedIn)).rejects.toMatchObject({ status: 503 });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
