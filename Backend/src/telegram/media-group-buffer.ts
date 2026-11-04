/**
 * Buffers Telegram album (media group) photos.
 *
 * Telegram delivers an album as N separate photo updates that share a
 * `media_group_id` and arrive back-to-back; typically only one carries the
 * caption. This buffer collects them per group id, keeps album order, caps the
 * count, retains the first non-empty caption, and flushes once a quiet window
 * (debounce) elapses with no new photos.
 *
 * Pure and I/O-free so it can be unit-tested with fake timers. The owner
 * supplies the flush callback that runs the listing pipeline, and may attach
 * an opaque context `C` to each photo (the bot's reply context).
 */
export interface FlushedGroup<C = unknown> {
  tgUserId: number;
  fileIds: string[]; // ordered, deduped, capped
  caption: string | null;
  /** The context attached to the group's latest photo, if any. */
  ctx?: C;
}

interface PendingGroup<C> {
  fileIds: string[];
  seen: Set<string>;
  caption: string | null;
  tgUserId: number;
  ctx?: C;
  timer: ReturnType<typeof setTimeout> | null;
}

export class MediaGroupBuffer<C = unknown> {
  private readonly groups = new Map<string, PendingGroup<C>>();

  constructor(
    private readonly debounceMs: number,
    private readonly maxImages: number,
    private readonly onFlush: (group: FlushedGroup<C>) => void,
  ) {}

  /** Add one album photo; (re)arms the debounce timer for its group. */
  add(
    groupId: string,
    fileId: string,
    caption: string | null,
    tgUserId: number,
    ctx?: C,
  ): void {
    let group = this.groups.get(groupId);
    if (!group) {
      group = {
        fileIds: [],
        seen: new Set(),
        caption: null,
        tgUserId,
        timer: null,
      };
      this.groups.set(groupId, group);
    }

    // First non-empty caption wins (one description per album).
    if (!group.caption && caption && caption.trim() !== '') {
      group.caption = caption;
    }
    // The latest context wins. It lives ON the group, so two albums of one
    // user, flushed one after the other, each keep their own.
    if (ctx !== undefined) group.ctx = ctx;
    // Preserve order, dedupe, and cap.
    if (!group.seen.has(fileId) && group.fileIds.length < this.maxImages) {
      group.seen.add(fileId);
      group.fileIds.push(fileId);
    }

    if (group.timer) clearTimeout(group.timer);
    group.timer = setTimeout(() => this.flush(groupId), this.debounceMs);
  }

  /** Force-flush a group (used by the timer; exposed for completeness). */
  private flush(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    if (group.timer) clearTimeout(group.timer);
    this.groups.delete(groupId);
    this.onFlush({
      tgUserId: group.tgUserId,
      fileIds: group.fileIds,
      caption: group.caption,
      ctx: group.ctx,
    });
  }

  /** Cancel all pending timers (shutdown). */
  clear(): void {
    for (const g of this.groups.values()) {
      if (g.timer) clearTimeout(g.timer);
    }
    this.groups.clear();
  }
}
