import { MediaGroupBuffer, FlushedGroup } from './media-group-buffer';

describe('MediaGroupBuffer', () => {
  const DEBOUNCE = 1500;
  const MAX = 10;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  function makeBuffer() {
    const flushed: FlushedGroup[] = [];
    const buf = new MediaGroupBuffer(DEBOUNCE, MAX, (g) => flushed.push(g));
    return { buf, flushed };
  }

  it('flushes a group after the debounce window, preserving arrival order', () => {
    const { buf, flushed } = makeBuffer();
    buf.add('g1', 'a', 'caption', 1);
    buf.add('g1', 'b', null, 1);
    buf.add('g1', 'c', null, 1);

    expect(flushed).toHaveLength(0); // not yet
    jest.advanceTimersByTime(DEBOUNCE);

    expect(flushed).toHaveLength(1);
    expect(flushed[0].fileIds).toEqual(['a', 'b', 'c']);
    expect(flushed[0].caption).toBe('caption');
    expect(flushed[0].tgUserId).toBe(1);
  });

  it('keeps the FIRST non-empty caption (one description per album)', () => {
    const { buf, flushed } = makeBuffer();
    buf.add('g1', 'a', null, 1); // no caption
    buf.add('g1', 'b', 'the description', 1); // first real caption
    buf.add('g1', 'c', 'second caption ignored', 1);
    jest.advanceTimersByTime(DEBOUNCE);

    expect(flushed[0].caption).toBe('the description');
  });

  it('treats a whitespace-only caption as empty', () => {
    const { buf, flushed } = makeBuffer();
    buf.add('g1', 'a', '   ', 1);
    buf.add('g1', 'b', 'real', 1);
    jest.advanceTimersByTime(DEBOUNCE);
    expect(flushed[0].caption).toBe('real');
  });

  it('caps the album at MAX images, dropping the overflow', () => {
    const { buf, flushed } = makeBuffer();
    for (let i = 0; i < 15; i++) buf.add('g1', `f${i}`, i === 0 ? 'cap' : null, 1);
    jest.advanceTimersByTime(DEBOUNCE);

    expect(flushed[0].fileIds).toHaveLength(MAX);
    expect(flushed[0].fileIds[0]).toBe('f0');
    expect(flushed[0].fileIds[MAX - 1]).toBe('f9');
    expect(flushed[0].fileIds).not.toContain('f10');
  });

  it('dedupes repeated file ids within a group', () => {
    const { buf, flushed } = makeBuffer();
    buf.add('g1', 'a', 'cap', 1);
    buf.add('g1', 'a', null, 1); // duplicate
    buf.add('g1', 'b', null, 1);
    jest.advanceTimersByTime(DEBOUNCE);

    expect(flushed[0].fileIds).toEqual(['a', 'b']);
  });

  it('resets the debounce timer on each new photo (does not flush early)', () => {
    const { buf, flushed } = makeBuffer();
    buf.add('g1', 'a', 'cap', 1);
    jest.advanceTimersByTime(DEBOUNCE - 100); // almost fires
    buf.add('g1', 'b', null, 1); // resets the timer
    jest.advanceTimersByTime(DEBOUNCE - 100); // still within the new window
    expect(flushed).toHaveLength(0);
    jest.advanceTimersByTime(100); // now the window elapses
    expect(flushed).toHaveLength(1);
    expect(flushed[0].fileIds).toEqual(['a', 'b']);
  });

  it('keeps separate groups independent', () => {
    const { buf, flushed } = makeBuffer();
    buf.add('g1', 'a', 'cap1', 1);
    buf.add('g2', 'x', 'cap2', 2);
    jest.advanceTimersByTime(DEBOUNCE);

    expect(flushed).toHaveLength(2);
    const byUser = Object.fromEntries(flushed.map((f) => [f.tgUserId, f]));
    expect(byUser[1].fileIds).toEqual(['a']);
    expect(byUser[1].caption).toBe('cap1');
    expect(byUser[2].fileIds).toEqual(['x']);
    expect(byUser[2].caption).toBe('cap2');
  });

  it('clear() cancels pending timers so nothing flushes', () => {
    const { buf, flushed } = makeBuffer();
    buf.add('g1', 'a', 'cap', 1);
    buf.clear();
    jest.advanceTimersByTime(DEBOUNCE * 2);
    expect(flushed).toHaveLength(0);
  });

  it('flushes a single-photo album with a null caption when none given', () => {
    const { buf, flushed } = makeBuffer();
    buf.add('g1', 'only', null, 7);
    jest.advanceTimersByTime(DEBOUNCE);
    expect(flushed[0]).toEqual({ tgUserId: 7, fileIds: ['only'], caption: null });
  });
});
