import { applyKey, type KeyState } from './terminal-prompt';

function type(keys: string): {
  value: string;
  done: boolean;
  aborted: boolean;
} {
  let state: KeyState = { value: '', escape: false };
  for (const ch of keys) {
    const step = applyKey(state, ch);
    state = step.state;
    if (step.done) return { value: state.value, done: true, aborted: false };
    if (step.aborted) return { value: state.value, done: false, aborted: true };
  }
  return { value: state.value, done: false, aborted: false };
}

describe('hidden terminal input', () => {
  it('collects characters until Enter', () => {
    expect(type('12345\r')).toEqual({
      value: '12345',
      done: true,
      aborted: false,
    });
    expect(type('pässwörd\n')).toMatchObject({ value: 'pässwörd', done: true });
  });

  it('handles backspace, including multi-byte characters', () => {
    expect(type('12x\u007f3\r').value).toBe('123');
    expect(type('пароль\u007f\u007f\r').value).toBe('паро');
    expect(type('\u007f\u007fa\r').value).toBe('a');
  });

  it('Ctrl+C aborts and forgets what was typed', () => {
    expect(type('secret\u0003')).toEqual({
      value: '',
      done: false,
      aborted: true,
    });
  });

  it('ignores arrow keys and other control characters', () => {
    expect(type('ab\u001b[Dc\u001b[1;5C\u001bOAd\t\r').value).toBe('abcd');
  });
});
