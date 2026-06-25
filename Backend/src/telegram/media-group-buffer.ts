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
 * supplies the flush callback that runs the listing pipeline.
 */
export interface FlushedGroup {
  tgUserId: number;
  fileIds: string[]; // ordered, deduped, capped
  caption: string | null;
}

interface PendingGroup {
  fileIds: string[];
  seen: Set<string>;
  caption: string | null;
  tgUserId: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class MediaGroupBuffer {
  private readonly groups = new Map<string, PendingGroup>();

  constructor(
    private readonly debounceMs: number,
    private readonly maxImages: number,
    private readonly onFlush: (group: FlushedGroup) => void,
  ) {}

  /** Add one album photo; (re)arms the debounce timer for its group. */
  add(groupId: string, fileId: string, caption: string | null, tgUserId: number): void {
    let group = this.groups.get(groupId);
    if (!group) {
      group = { fileIds: [], seen: new Set(), caption: null, tgUserId, timer: null };
      this.groups.set(groupId, group);
    }

    // First non-empty caption wins (one description per album).
    if (!group.caption && caption && caption.trim() !== '') {
      group.caption = caption;
    }
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
