import type { FileSnapshot } from '../types';

export interface SnapshotContent { ref: string; hash: string; content: string; }

export class SnapshotStore {
  private readonly content = new Map<string, SnapshotContent>();
  put(snapshot: FileSnapshot, content: string): SnapshotContent {
    const ref = snapshot.contentRef ?? `spatial://snapshot/${snapshot.id}`;
    const hash = `${content.length}:${content.slice(0, 32)}:${content.slice(-32)}`;
    const value = { ref, hash, content };
    this.content.set(ref, value);
    return value;
  }
  get(ref: string): SnapshotContent | undefined { return this.content.get(ref); }
  resolve(ref: string): string | undefined { return this.content.get(ref)?.content; }
}

export interface RestoreCapability {
  enabled: boolean;
  restore(snapshot: FileSnapshot, currentHash: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export function disabledRestoreCapability(): RestoreCapability { return { enabled: false, async restore() { return { ok: false, reason: 'Restore is unavailable until a safe Harness host capability is registered.' }; } }; }
