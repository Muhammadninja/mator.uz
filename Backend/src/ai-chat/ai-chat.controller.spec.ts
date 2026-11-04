// The ticket owner must come ONLY from a verified bearer — never the
// client-supplied dto.userId — so a caller can't tie a ticket (and its offer
// notifications) to another account.

import { AiChatController } from './ai-chat.controller';
import type { Request } from 'express';

function build() {
  const captured: { dto?: any } = {};
  const aiChat = {
    processUserMessage: jest.fn(async (dto: any) => {
      captured.dto = dto;
      return { reply_text: 'ok', intent: 'GENERAL_QUESTION', extracted_data: {} };
    }),
  };
  const controller = new AiChatController(aiChat as never);
  return { controller, captured, aiChat };
}

describe('AiChatController.sendMessage — ticket ownership', () => {
  it('overrides userId with the verified bearer id', async () => {
    const { controller, captured } = build();
    // Client tries to spoof userId; a valid token authenticates a different user.
    const dto = { message: 'нужны колодки', userId: 'victim-uuid' } as any;
    const req = { user: { id: 'real-user-uuid' } } as unknown as Request;

    await controller.sendMessage(dto, req);

    expect(captured.dto.userId).toBe('real-user-uuid');
  });

  it('drops the client-supplied userId when unauthenticated (anonymous ticket)', async () => {
    const { controller, captured } = build();
    const dto = { message: 'нужны колодки', userId: 'victim-uuid' } as any;
    const req = {} as Request; // no req.user → anonymous

    await controller.sendMessage(dto, req);

    expect(captured.dto.userId).toBeUndefined();
  });
});

describe('AiChatController.sendMessage — request context', () => {
  const req = { user: { id: 'u1' } } as unknown as Request;

  it('passes the verified user, request id and vehicle on', async () => {
    const { controller, aiChat } = build();
    await controller.sendMessage({ message: 'x' } as never, req, 'user-123:v1', 'v1');
    expect(aiChat.processUserMessage).toHaveBeenCalledWith(expect.anything(), {
      userId: 'u1',
      idempotencyKey: 'user-123:v1',
      selectedVehicleId: 'v1',
    });
  });

  it.each(['short', 'has spaces in it', 'x'.repeat(129)])('rejects request id %s', async (key) => {
    const { controller, aiChat } = build();
    expect(() => controller.sendMessage({ message: 'x' } as never, req, key)).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'INVALID_IDEMPOTENCY_KEY' }) }),
    );
    expect(aiChat.processUserMessage).not.toHaveBeenCalled();
  });
});
