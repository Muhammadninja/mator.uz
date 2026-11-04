/**
 * Interactive input for the login command — on a real terminal only.
 *
 * Hidden prompts (login code, 2FA password, e-mail code) switch the terminal
 * to raw mode and echo nothing; the typed value lives only in memory and is
 * handed straight to TDLib. Nothing here writes a value anywhere.
 */
import { createInterface } from 'readline';

export class PromptAbortedError extends Error {
  constructor() {
    super('Cancelled at the prompt.');
    this.name = 'PromptAbortedError';
  }
}

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** A visible prompt (phone number, e-mail address). */
export async function askVisible(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.once('SIGINT', () => reject(new PromptAbortedError()));
      rl.question(question, resolve);
    });
  } finally {
    rl.close();
  }
}

/** A prompt that echoes nothing (login code, password). */
export function askHidden(question: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  return new Promise((resolve, reject) => {
    output.write(question);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    let state: KeyState = { value: '', escape: false };
    const finish = (error?: Error) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(state.value);
      state = { value: '', escape: false };
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const step = applyKey(state, ch);
        state = step.state;
        if (step.done) return finish();
        if (step.aborted) return finish(new PromptAbortedError());
      }
    };
    input.on('data', onData);
  });
}

export interface KeyState {
  value: string;
  /** Inside an escape sequence (arrow keys etc.), which is ignored. */
  escape: boolean;
}

/** One typed character → the new input state (pure, for tests). */
export function applyKey(
  state: KeyState,
  ch: string,
): { state: KeyState; done?: boolean; aborted?: boolean } {
  if (state.escape) {
    // CSI sequences end with a byte in @–~; '[' and 'O' continue them.
    const ends = ch >= '@' && ch <= '~' && ch !== '[' && ch !== 'O';
    return { state: { value: state.value, escape: !ends } };
  }
  switch (ch) {
    case '\r':
    case '\n':
    case '\u0004': // Ctrl+D
      return { state, done: true };
    case '\u0003': // Ctrl+C
      return { state: { value: '', escape: false }, aborted: true };
    case '\u007f':
    case '\b':
      return {
        state: {
          value: Array.from(state.value).slice(0, -1).join(''),
          escape: false,
        },
      };
    case '\u001b':
      return { state: { value: state.value, escape: true } };
    default:
      if (ch < ' ') return { state }; // other control characters
      return { state: { value: state.value + ch, escape: false } };
  }
}
