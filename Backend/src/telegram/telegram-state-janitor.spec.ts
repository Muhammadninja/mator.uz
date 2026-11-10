// LOW-ING-012: idle per-user dialogue state is forgotten; active state is kept.

import { WizardSessionStore } from './product-wizard';
import { TelegramStateJanitor } from './telegram-state-janitor';

const HOUR = 60 * 60 * 1000;

describe('TelegramStateJanitor', () => {
  function setup() {
    const wizard = new WizardSessionStore();
    const livePrompt = new Map<number, { chatId: number; messageId: number }>();
    const langCache = new Map<number, string>();
    const staleNotice = new Map<number, number>();
    const janitor = new TelegramStateJanitor(
      25 * HOUR,
      [wizard, livePrompt, langCache],
      [{ map: staleNotice, ttlMs: 5000 }],
    );
    return { wizard, livePrompt, langCache, staleNotice, janitor };
  }

  it('forgets every map entry of a user idle past the threshold', () => {
    const { wizard, livePrompt, langCache, staleNotice, janitor } = setup();
    wizard.start(1);
    livePrompt.set(1, { chatId: 1, messageId: 9 });
    langCache.set(1, 'ru');
    staleNotice.set(1, 0);
    janitor.touch(1, 0);

    expect(janitor.sweep(26 * HOUR)).toBe(1);

    expect(wizard.get(1)).toBeUndefined();
    expect(livePrompt.has(1)).toBe(false);
    expect(langCache.has(1)).toBe(false);
    expect(staleNotice.has(1)).toBe(false);
    expect(janitor.size).toBe(0);
  });

  it('keeps a user who is still active, wizard draft included', () => {
    const { wizard, livePrompt, janitor } = setup();
    const session = wizard.start(2);
    session.draftId = 'draft_1';
    livePrompt.set(2, { chatId: 2, messageId: 3 });
    janitor.touch(2, 0);
    janitor.touch(2, 20 * HOUR); // answered a question later on

    expect(janitor.sweep(26 * HOUR)).toBe(0);
    expect(wizard.get(2)).toBe(session);
    expect(livePrompt.has(2)).toBe(true);
  });

  it('expires dedup timestamps on their own short schedule', () => {
    const { staleNotice, janitor } = setup();
    staleNotice.set(3, 1000);
    janitor.touch(3, 1000);
    janitor.sweep(4000);
    expect(staleNotice.has(3)).toBe(true);
    janitor.sweep(7000);
    expect(staleNotice.has(3)).toBe(false);
  });

  it('a stream of distinct senders does not grow the state without bound', () => {
    const { langCache, janitor } = setup();
    for (let user = 0; user < 5000; user++) {
      langCache.set(user, 'uz');
      janitor.touch(user, 0);
    }
    janitor.sweep(26 * HOUR);
    expect(langCache.size).toBe(0);
    expect(janitor.size).toBe(0);
  });

  it('runs on an unref timer and stops cleanly', () => {
    jest.useFakeTimers();
    try {
      const { janitor } = setup();
      const sweep = jest.spyOn(janitor, 'sweep');
      janitor.start(1000);
      jest.advanceTimersByTime(3000);
      expect(sweep).toHaveBeenCalledTimes(3);
      janitor.stop();
      jest.advanceTimersByTime(3000);
      expect(sweep).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });
});
