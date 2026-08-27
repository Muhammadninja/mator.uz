import { ClaudeService } from './claude.service';
import { MAX_TOOL_ROUNDS } from './catalog-tools.service';
import { fakeConfig } from '../../test/utils/harness';
import { DEFAULT_AI_MODEL } from './ai-advisor.config';

/**
 * The provider is ALWAYS mocked here — no test in this suite may make a live
 * API call. The `client` is replaced after construction, which is also how the
 * real no-API-key path is exercised (client stays null → stub replies).
 */

/** A provider response that ends the turn with prose. */
function textResponse(text: string) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
}

/** A provider response asking for one tool call. */
function toolResponse(
  name: string,
  input: Record<string, unknown> = {},
  id = 'tu_1',
) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id, name, input }],
  };
}

function buildService(
  toolRun: jest.Mock = jest.fn(),
  env: Record<string, string | undefined> = {},
) {
  const tools = { run: toolRun };
  const svc = new ClaudeService(fakeConfig(env), tools as never);
  return { svc, tools };
}

/** Attach a mocked Anthropic client to a service built without an API key. */
function withClient(svc: ClaudeService, create: jest.Mock) {
  (svc as unknown as { client: unknown }).client = { messages: { create } };
  return svc;
}

describe('ClaudeService', () => {
  describe('configuration', () => {
    it('defaults the model to the pinned snapshot when unset', () => {
      const { svc } = buildService();
      expect((svc as unknown as { cfg: { model: string } }).cfg.model).toBe(
        DEFAULT_AI_MODEL,
      );
    });

    it('takes the model from the environment — never hardcoded', () => {
      const { svc } = buildService(jest.fn(), {
        AI_ADVISOR_MODEL: 'claude-test-model',
      });
      expect((svc as unknown as { cfg: { model: string } }).cfg.model).toBe(
        'claude-test-model',
      );
    });

    it('reads the rate limit and message ceiling from the environment', () => {
      const { svc } = buildService(jest.fn(), {
        AI_ADVISOR_RATE_LIMIT: '3',
        AI_ADVISOR_RATE_WINDOW_SECONDS: '60',
        AI_ADVISOR_MAX_MESSAGE_CHARS: '500',
      });
      expect(svc.rateLimit).toBe(3);
      expect(svc.rateWindowSeconds).toBe(60);
      expect(svc.maxMessageChars).toBe(500);
    });

    it('falls back to the default when a limit is malformed — never to "unlimited"', () => {
      const { svc } = buildService(jest.fn(), {
        AI_ADVISOR_RATE_LIMIT: 'not-a-number',
        AI_ADVISOR_MAX_MESSAGE_CHARS: '-5',
      });
      expect(svc.rateLimit).toBeGreaterThan(0);
      expect(svc.maxMessageChars).toBeGreaterThan(0);
    });

    it('reports as unconfigured without an API key', () => {
      const { svc } = buildService();
      expect(svc.isConfigured).toBe(false);
    });
  });

  describe('system prompt', () => {
    it('grounds the car context and passes the vehicle id for tool use', () => {
      const { svc } = buildService();
      const sys = svc.buildSystem({
        vehicle_id: 'veh_1',
        make: 'Chevrolet',
        model: 'Cobalt',
        year: 2022,
        engine: 'B15D2',
      });
      expect(sys).toContain('Chevrolet Cobalt 2022');
      expect(sys).toContain('B15D2');
      expect(sys).toContain('veh_1');
    });

    it('forbids inventing catalogue facts and fences off instruction injection', () => {
      const { svc } = buildService();
      const sys = svc.buildSystem(null);
      expect(sys).toContain('search_catalog');
      expect(sys).toContain('find_motor_oil');
      // Catalogue text and user messages are data, not instructions.
      expect(sys).toMatch(/MA'LUMOT, ko'rsatma emas/);
    });

    it('never interpolates anything beyond make/model/year/engine', () => {
      const { svc } = buildService();
      const sys = svc.buildSystem({
        vehicle_id: 'veh_1',
        make: 'Chevrolet',
        model: 'Cobalt',
        year: 2022,
        engine: null,
      });
      expect(sys).not.toMatch(/\+998|@|password|token/i);
    });
  });

  describe('stub mode (no API key)', () => {
    it('answers without a provider call', async () => {
      const { svc } = buildService();
      const res = await svc.reply('sys', [
        { role: 'user', content: 'Dvigatel shovqin qilyapti' },
      ]);
      expect(res.outcome).toBe('ok');
      expect(res.text).toContain('test rejimidagi');
      expect(res.citedItems).toBe(0);
    });
  });

  describe('tool calling', () => {
    it('runs a requested tool and feeds the result back to the provider', async () => {
      const toolRun = jest.fn().mockResolvedValue({
        content: '{"items":[{"part_id":"p1"}],"total":1}',
        itemCount: 1,
      });
      const create = jest
        .fn()
        .mockResolvedValueOnce(
          toolResponse('search_catalog', { q: 'brake pads' }),
        )
        .mockResolvedValueOnce(
          textResponse("Tormoz kolodkalari 185 000 so'm."),
        );

      const { svc } = buildService(toolRun);
      withClient(svc, create);

      const res = await svc.reply('sys', [{ role: 'user', content: 'tormoz' }]);

      // The third argument is the language the tools label categories in; it
      // defaults to the platform default when `reply` is called without one.
      expect(toolRun).toHaveBeenCalledWith(
        'search_catalog',
        { q: 'brake pads' },
        'ru',
      );
      expect(res.citedItems).toBe(1);
      expect(res.toolRounds).toBe(1);
      expect(res.outcome).toBe('ok');

      // The second call must carry the tool result back as a tool_result block.
      const secondCall = create.mock.calls[1][0];
      const lastTurn = secondCall.messages[secondCall.messages.length - 1];
      expect(lastTurn.role).toBe('user');
      expect(lastTurn.content[0].type).toBe('tool_result');
      expect(lastTurn.content[0].tool_use_id).toBe('tu_1');
    });

    it('advertises the catalogue tools on every provider call', async () => {
      const create = jest.fn().mockResolvedValue(textResponse('salom'));
      const { svc } = buildService();
      withClient(svc, create);

      await svc.reply('sys', [{ role: 'user', content: 'salom' }]);
      const names = create.mock.calls[0][0].tools.map(
        (t: { name: string }) => t.name,
      );
      expect(names).toContain('search_catalog');
      expect(names).toContain('find_motor_oil');
    });

    it('counts catalogue rows across several tool calls in one round', async () => {
      const toolRun = jest
        .fn()
        .mockResolvedValueOnce({ content: '{}', itemCount: 2 })
        .mockResolvedValueOnce({ content: '{}', itemCount: 3 });
      const create = jest
        .fn()
        .mockResolvedValueOnce({
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'a', name: 'search_catalog', input: {} },
            { type: 'tool_use', id: 'b', name: 'get_categories', input: {} },
          ],
        })
        .mockResolvedValueOnce(textResponse('javob'));

      const { svc } = buildService(toolRun);
      withClient(svc, create);

      const res = await svc.reply('sys', [{ role: 'user', content: 'x' }]);
      expect(res.citedItems).toBe(5);
    });

    it('stops after the round ceiling instead of looping forever', async () => {
      const toolRun = jest
        .fn()
        .mockResolvedValue({ content: '{}', itemCount: 0 });
      // The provider always asks for another tool — the loop must still end.
      const create = jest
        .fn()
        .mockResolvedValue(toolResponse('search_catalog'));

      const { svc } = buildService(toolRun);
      withClient(svc, create);

      const res = await svc.reply('sys', [{ role: 'user', content: 'x' }]);
      expect(res.toolRounds).toBe(MAX_TOOL_ROUNDS);
      expect(create.mock.calls.length).toBeLessThanOrEqual(MAX_TOOL_ROUNDS + 1);
      expect(res.text).toBeTruthy();
    });

    it('reports zero cited items when the model answers without any tool', async () => {
      const create = jest
        .fn()
        .mockResolvedValue(textResponse('Umumiy maslahat.'));
      const { svc } = buildService();
      withClient(svc, create);

      const res = await svc.reply('sys', [{ role: 'user', content: 'salom' }]);
      expect(res.citedItems).toBe(0);
      expect(res.toolRounds).toBe(0);
    });
  });

  describe('failure handling', () => {
    it('reports a provider failure as an outcome, never as a thrown error', async () => {
      const create = jest.fn().mockRejectedValue(new Error('503 upstream'));
      const { svc } = buildService();
      withClient(svc, create);

      const res = await svc.reply('sys', [{ role: 'user', content: 'x' }]);
      expect(res.outcome).toBe('provider_failed');
      expect(res.text).toContain('qayta urinib');
      // The upstream detail must not reach the user-visible text.
      expect(res.text).not.toContain('503');
    });

    it('reports a hung provider as a timeout within the configured budget', async () => {
      // Never settles — only the timeout can end this turn.
      const create = jest.fn().mockReturnValue(new Promise(() => {}));
      const { svc } = buildService(jest.fn(), { AI_ADVISOR_TIMEOUT_MS: '20' });
      withClient(svc, create);

      const res = await svc.reply('sys', [{ role: 'user', content: 'x' }]);
      expect(res.outcome).toBe('timed_out');
      expect(res.text).toContain('qayta urinib');
    });

    it('keeps rows already cited when a later round fails', async () => {
      const toolRun = jest
        .fn()
        .mockResolvedValue({ content: '{}', itemCount: 2 });
      const create = jest
        .fn()
        .mockResolvedValueOnce(toolResponse('search_catalog'))
        .mockRejectedValueOnce(new Error('boom'));

      const { svc } = buildService(toolRun);
      withClient(svc, create);

      const res = await svc.reply('sys', [{ role: 'user', content: 'x' }]);
      expect(res.outcome).toBe('provider_failed');
      expect(res.citedItems).toBe(2);
    });

    it('handles a malformed provider response without throwing', async () => {
      const create = jest
        .fn()
        .mockResolvedValue({ stop_reason: 'end_turn', content: [] });
      const { svc } = buildService();
      withClient(svc, create);

      const res = await svc.reply('sys', [{ role: 'user', content: 'x' }]);
      expect(res.outcome).toBe('ok');
      expect(typeof res.text).toBe('string');
    });
  });
});
