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
