// DraftTelemetry must never let observability break the business flow: even if the
// underlying Logger throws (or, later, a real metrics client doing network I/O),
// event()/metric() must swallow it and return normally.

import { DraftTelemetry, DraftMetric } from './draft-telemetry';

describe('DraftTelemetry never throws into the flow', () => {
  it('event() swallows a throwing logger', () => {
    const t = new DraftTelemetry();
    jest
      .spyOn((t as never as { events: { log: () => void } }).events, 'log')
      .mockImplementation(() => {
        throw new Error('logger down');
      });
    expect(() => t.event('draft.created', { draftId: 'd1' })).not.toThrow();
  });

  it('metric() swallows a throwing logger', () => {
    const t = new DraftTelemetry();
    jest
      .spyOn((t as never as { metrics: { log: () => void } }).metrics, 'log')
      .mockImplementation(() => {
        throw new Error('metrics client down');
      });
    expect(() =>
      t.metric(DraftMetric.DRAFT_PUBLISHED, { draftId: 'd1', sellerId: 1 }),
    ).not.toThrow();
  });

  it('emits normally with only the present id fields (no PII/extra keys)', () => {
    const t = new DraftTelemetry();
    const log = jest
      .spyOn(
        (t as never as { events: { log: (m: string) => void } }).events,
        'log',
      )
      .mockImplementation(() => undefined);
    t.event('image.ready', { draftId: 'd1', imageId: 'i1', jobId: 'j1' });
    const msg = log.mock.calls[0][0];
    expect(msg).toContain('event=image.ready');
    expect(msg).toContain('"draftId":"d1"');
    expect(msg).toContain('"imageId":"i1"');
    expect(msg).toContain('"jobId":"j1"');
    expect(msg).not.toContain('sellerId'); // omitted when not provided
  });
});
