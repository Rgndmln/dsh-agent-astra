export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type EntityKind = 'agent' | 'subagent' | 'file' | 'tool' | 'external' | 'event' | 'unknown';
export type AgentState = 'running' | 'waiting' | 'completed' | 'error';
export type RelationKind = 'read' | 'write' | 'tool-call' | 'delegate' | 'flow';
export type EventKind = 'prompt' | 'agent' | 'checkpoint' | 'file' | 'tool' | 'subagent' | 'external' | 'unknown';
export type TrajectoryEventRole = 'agent-start' | 'agent-end' | 'user-message' | 'assistant-message';
export type ActivityAction = 'prompt' | 'respond' | 'read' | 'write' | 'execute' | 'delegate' | 'start' | 'complete' | 'observe';

export interface HarnessEvent {
  sessionId: string;
  seq: number;
  timestamp?: number;
  type: string;
  data?: Record<string, unknown>;
}

export interface FileSnapshot {
  id: string;
  fileId: string;
  path: string;
  seq: number;
  timestamp?: number;
  exact: boolean;
  size?: number;
  lineCount?: number;
  contentRef?: string;
  /**
   * Exact content carried by the current event window. It is deliberately
   * transient: browser preferences never persist snapshot bodies.
   */
  content?: string;
  change?: { added?: number; removed?: number };
}

export interface SpatialCheckpoint {
  id: string;
  seq: number;
  timestamp?: number;
  agentId: string;
  kind: EventKind;
  title: string;
  summary: string;
  state?: AgentState;
  eventType: string;
  responsePreview?: string;
  toolCalls: string[];
  action?: ActivityAction;
  outcomePreview?: string;
  /** Stable semantic record. It points back to every raw Harness event that formed this checkpoint. */
  activityId?: string;
  sourceSeqs?: number[];
}

/**
 * A compact, causally-linked reading of one user-visible or operational action.
 *
 * Raw Harness events remain in `SpatialSceneState.events`; the record only keeps
 * short render-safe previews plus `sourceSeqs`, so the scene does not duplicate
 * large tool payloads while an inspector can always recover the exact source.
 */
export interface SpatialActivity {
  id: string;
  kind: EventKind;
  action: ActivityAction;
  actorId: string;
  title: string;
  summary: string;
  startSeq: number;
  endSeq?: number;
  sourceSeqs: number[];
  sourceTypes: string[];
  state?: AgentState;
  /** Tiny replay samples; prevents a future result from leaking into an earlier cursor position. */
  stateHistory: Array<{ seq: number; state?: AgentState; summary?: string; outcomePreview?: string }>;
  callId?: string;
  toolName?: string;
  filePath?: string;
  externalUrl?: string;
  inputPreview?: string;
  outcomePreview?: string;
  entityIds: string[];
}

export interface SpatialEntity {
  id: string;
  kind: EntityKind;
  label: string;
  path?: string;
  toolName?: string;
  url?: string;
  parentAgentId?: string;
  branchDepth: number;
  state?: AgentState;
  model?: string;
  task?: string;
  eventRole?: TrajectoryEventRole;
  message?: string;
  messageHistory?: Array<{ seq: number; content: string }>;
  importance?: number;
  firstSeq: number;
  lastSeq: number;
  position: [number, number, number];
  trail: Array<[number, number, number]>;
  snapshots: FileSnapshot[];
  metadata: Record<string, string>;
}

export interface SpatialStation {
  id: string;
  index: number;
  turn?: string;
  startSeq: number;
  endSeq: number;
  startX: number;
  endX: number;
  centerX: number;
  complexity: number;
  entityIds: string[];
  userEntityIds: string[];
  responseEntityIds: string[];
  toolEntityIds: string[];
  fileEntityIds: string[];
}

export interface SpatialLayout {
  startX: number;
  endX: number;
  seqX: Map<number, number>;
  seqOrder: number[];
}

export interface SpatialRelation {
  id: string;
  kind: RelationKind;
  sourceId: string;
  targetId: string;
  startSeq: number;
  endSeq?: number;
  state: 'active' | 'completed' | 'error';
  label?: string;
}

export interface SpatialSceneState {
  sessionId: string;
  entities: Map<string, SpatialEntity>;
  relations: Map<string, SpatialRelation>;
  activities: Map<string, SpatialActivity>;
  checkpoints: SpatialCheckpoint[];
  events: HarnessEvent[];
  cursorSeq: number;
  range: { startSeq: number; endSeq: number; hasOlder: boolean };
  live: { running: boolean; tailSeq: number; newEvents: number };
  issues: string[];
  stations: SpatialStation[];
  layout: SpatialLayout;
}

export interface NormalizedEvent {
  event: HarnessEvent;
  kind: EventKind;
  agentId: string;
  title: string;
  summary: string;
  callId?: string;
  filePath?: string;
  toolName?: string;
  externalUrl?: string;
  parentAgentId?: string;
  state?: AgentState;
  model?: string;
  task?: string;
  responsePreview?: string;
  exactSnapshot?: boolean;
  snapshotContent?: string;
  snapshotChange?: { added?: number; removed?: number };
  inputPreview?: string;
  outcomePreview?: string;
  action?: ActivityAction;
}
