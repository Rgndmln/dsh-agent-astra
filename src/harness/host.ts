import { SnapshotStore, disabledRestoreCapability } from './snapshot-store.js';

export interface HarnessHostContext { sessions?: unknown; }
export interface SpatialHostPlugin { name: string; snapshotStore: SnapshotStore; restore: ReturnType<typeof disabledRestoreCapability>; apply(ctx: HarnessHostContext): void; }

export function createSpatialHostPlugin(): SpatialHostPlugin {
  const snapshotStore = new SnapshotStore();
  return { name: 'spatial-trajectory-host', snapshotStore, restore: disabledRestoreCapability(), apply(_ctx) { /* observer/capabilities stay host-side */ } };
}

/** Cordis host entry. Restore is intentionally not mounted as a write capability. */
export function applySpatialHostPlugin(_ctx?: HarnessHostContext): void {
  // The browser view is read-only until a future host contract supplies conflict-checked writes.
}
