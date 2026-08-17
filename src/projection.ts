import type {
  ActivityAction,
  AgentState,
  EventKind,
  HarnessEvent,
  NormalizedEvent,
  SpatialActivity,
  SpatialCheckpoint,
  SpatialEntity,
  SpatialRelation,
  SpatialSceneState,
} from './types';
import { applyStationLayout } from './station-layout';

export const PROJECTION_VERSION = 'spatial-trajectory-v0.1';
export const MAX_TIMELINE_CHECKPOINTS = 2_000;
export const MAX_TRAIL_POINTS = 2_048;
export const MAX_FILE_LANDMARKS = 16;
const MAX_MESSAGE_SAMPLES = 120;
const BURST_WINDOW_MS = 1_500;

const text = (value: unknown): string => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const compact = (value: string, max = 140): string => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const safeHost = (value: string): string => { try { return new URL(value).hostname; } catch { return value; } };
const firstString = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === 'string' && value.length > 0);

function contentBlocks(value: unknown, into: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) contentBlocks(item, into);
    return into;
  }
  const record = object(value);
  if (!Object.keys(record).length) return into;
  into.push(record);
  if (record.content !== undefined) contentBlocks(record.content, into);
  return into;
}

function toolCallBlock(data: Record<string, unknown>): Record<string, unknown> | undefined {
  return contentBlocks([data.content, object(data.message).content]).find((block) => block.type === 'tool-call');
}

function toolResultBlocks(data: Record<string, unknown>): Record<string, unknown>[] {
  return contentBlocks([data.output, data.result, data.message]).filter((block) => block.type === 'tool-result');
}

function textInResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textInResult).filter(Boolean).join('\n');
  const record = object(value);
  if (!Object.keys(record).length) return '';
  if (record.type === 'text' && typeof record.text === 'string') return record.text;
  if (record.content !== undefined) return textInResult(record.content);
  return '';
}

function pathIn(value: unknown): string | undefined {
  const record = object(value);
  if (!Object.keys(record).length && typeof value === 'string') {
    try { return pathIn(JSON.parse(value)); } catch { return undefined; }
  }
  return firstString(record.path, record.file_path, record.filePath, record.filename);
}

const readPath = (data: Record<string, unknown>): string | undefined => {
  const call = toolCallBlock(data);
  const message = object(data.message);
  const source = object(message.source);
  // Native Harness fs tools use `file_path`; str_replace_editor and presentation
  // metadata use `path`. Accept both call and result spellings.
  return [data, data.input, data.arguments, call?.arguments, call?.input, message, source]
    .map(pathIn)
    .find((path): path is string => Boolean(path));
};

function readToolName(data: Record<string, unknown>): string | undefined {
  const call = toolCallBlock(data);
  const message = object(data.message);
  const source = object(message.source);
  return firstString(data.toolName, data.name, call?.name, call?.toolName, source.toolName, source.name);
}

function readCallId(data: Record<string, unknown>): string | undefined {
  const call = toolCallBlock(data);
  const result = toolResultBlocks(data)[0];
  const message = object(data.message);
  const source = object(message.source);
  return firstString(data.callId, data.toolCallId, call?.id, call?.callId, result?.toolCallId, result?.callId, source.callId, source.toolCallId);
}

function toolInputText(data: Record<string, unknown>): string {
  const call = toolCallBlock(data);
  return text(data.input ?? data.arguments ?? call?.arguments ?? call?.input ?? '');
}

function conciseToolInput(value: unknown): string {
  let input = value;
  if (typeof input === 'string') {
    const raw = input;
    try { input = JSON.parse(raw); } catch { return compact(raw, 96); }
  }
  const record = object(input);
  if (!Object.keys(record).length) return compact(text(input), 96);
  const command = firstString(record.command, record.cmd);
  if (command) return compact(command, 96);
  if (Array.isArray(record.todos)) return `${record.todos.length} to-do item${record.todos.length === 1 ? '' : 's'}`;
  const query = firstString(record.query, record.pattern, record.url);
  if (query) return compact(query, 96);
  const content = firstString(record.content, record.text);
  if (content) return compact(content, 96);
  return `${Object.keys(record).slice(0, 3).join(', ')}${Object.keys(record).length > 3 ? '…' : ''}`;
}

function toolSummary(toolName: string | undefined, filePath: string | undefined, input: unknown): string {
  const name = toolName ?? 'tool';
  if (filePath) return `${name} · ${filePath}`;
  const detail = conciseToolInput(input);
  return detail ? `${name} · ${detail}` : name;
}

function toolOutcomeText(data: Record<string, unknown>): string {
  const direct = [data.output, data.result]
    .map(textInResult)
    .find(Boolean);
  if (direct) return direct;
  const nested = toolResultBlocks(data).map((block) => textInResult(block.content)).find(Boolean);
  if (nested) return nested;
  return text(data.error ?? '');
}

function toolAction(toolName: string | undefined, filePath: string | undefined): ActivityAction {
  const name = toolName?.toLowerCase() ?? '';
  if (/(?:write|edit|patch|apply|create|mkdir|delete|remove|move|rename|copy)/.test(name)) return 'write';
  if (/(?:read|view|cat|list|glob|search|find|grep|stat|open)/.test(name)) return 'read';
  return filePath ? 'read' : 'execute';
}

type AssistantEventMode = 'stream' | 'message';

function assistantEventMode(type: string, data: Record<string, unknown>): AssistantEventMode | undefined {
  if (type.includes('assistant/message')) return 'message';
  const assistantScoped = type.includes('assistant/')
    || (type.includes('message/') && text(data.role).toLowerCase() === 'assistant');
  if (assistantScoped && /(?:chunk|delta|update|stream)/.test(type)) return 'stream';
  return undefined;
}

function isUserMessageEvent(type: string, data: Record<string, unknown>): boolean {
  return type.includes('user/message') || (type.includes('message/') && text(data.role).toLowerCase() === 'user');
}

/** Match the text projection used by Harness Chat: text blocks are visible; reasoning and tool blocks are not. */
function visibleBlockText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) {
    const block = object(value);
    return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
  }
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      const block = object(item);
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function userVisibleText(data: Record<string, unknown>): string {
  const source = object(data.source);
  // Harness Chat classifies plugin/goal/injected user-role messages as context,
  // not as the human-authored bubble shown in the transcript.
  if (Object.keys(source).length && source.kind !== 'user') return '';
  const nested = object(data.message);
  return visibleBlockText(data.content ?? nested.content ?? data.message);
}

function assistantEventText(data: Record<string, unknown>): string {
  const message = object(data.message);
  if (Object.keys(message).length) return visibleBlockText(message.content);
  const chunk = object(data.chunk);
  if (Object.keys(chunk).length) {
    if (chunk.type === 'text-delta') return typeof chunk.text === 'string' ? chunk.text : '';
    if (chunk.type === 'block-end') return visibleBlockText(chunk.block);
    return '';
  }
  const delta = object(data.delta);
  const deltaText = typeof data.delta === 'string' ? data.delta : delta.content ?? delta.text;
  return typeof deltaText === 'string'
    ? deltaText
    : visibleBlockText(data.content ?? data.message ?? data.text ?? data.responsePreview);
}

function isAppendSurfaceMessage(data: Record<string, unknown>): boolean {
  return data.surfaceOp === undefined || data.surfaceOp === 'append';
}

export function normalizeEvent(event: HarnessEvent): NormalizedEvent {
  const data = object(event.data);
  const type = event.type.toLowerCase();
  const agentId = typeof data.agentId === 'string' ? data.agentId : 'agent-main';
  const agentLabel = agentId === 'agent-main' ? 'Main Agent' : `Subagent ${agentId.slice(-1).toUpperCase()}`;
  const path = readPath(data);
  const toolName = readToolName(data);
  const callId = readCallId(data);
  const inputPreview = compact(toolInputText(data));
  const outcomePreview = compact(toolOutcomeText(data));
  const externalUrl = typeof data.externalUrl === 'string' ? data.externalUrl : typeof data.url === 'string' ? data.url : undefined;
  const resultBlock = toolResultBlocks(data)[0];
  const resultStatus = firstString(data.status, resultBlock?.status, data.error === undefined ? undefined : 'error')?.toLowerCase() ?? '';
  const state: AgentState | undefined = resultStatus === 'error' || resultStatus === 'failed' ? 'error' : resultStatus === 'success' || resultStatus === 'ok' ? 'completed' : undefined;
  const assistantMode = assistantEventMode(type, data);

  if (isUserMessageEvent(type, data)) return { event, kind: 'prompt', action: 'prompt', agentId: 'agent-main', title: 'User prompt', summary: compact(userVisibleText(data)), state: 'waiting' };
  if (type.includes('subagent/start')) return { event, kind: 'subagent', action: 'delegate', agentId, parentAgentId: text(data.parentAgentId) || 'agent-main', title: agentLabel, summary: compact(text(data.task ?? 'Delegated task')), task: text(data.task), model: text(data.model) || undefined, state: 'running' };
  if (type.includes('subagent/end')) return { event, kind: 'subagent', action: 'complete', agentId, parentAgentId: text(data.parentAgentId) || 'agent-main', title: agentLabel, summary: compact(text(data.result ?? data.message ?? 'Subagent completed')), state: state ?? 'completed' };
  if (type.includes('tool/call')) return { event, kind: 'tool', action: toolAction(toolName, path), agentId, title: toolName ?? 'Tool call', summary: toolSummary(toolName, path, data.input ?? data.arguments ?? toolCallBlock(data)?.arguments), callId, filePath: path, toolName, externalUrl, inputPreview, state: 'running' };
  if (type.includes('tool/result')) return { event, kind: 'tool', action: toolAction(toolName, path), agentId, title: toolName ?? 'Tool result', summary: outcomePreview || 'Tool completed', callId, filePath: path, toolName, externalUrl, outcomePreview, state: state ?? 'completed' };
  if (type.includes('file/snapshot') || type.includes('file/write') || type.includes('file/edit')) return { event, kind: 'file', action: 'write', agentId, title: path ?? 'File', summary: compact(path ? `Snapshot · ${path}` : 'File snapshot'), filePath: path, exactSnapshot: data.exact !== false, snapshotContent: typeof data.content === 'string' ? data.content : undefined, snapshotChange: { added: typeof data.added === 'number' ? data.added : undefined, removed: typeof data.removed === 'number' ? data.removed : undefined }, state: 'completed' };
  if (assistantMode === 'message') return { event, kind: 'agent', action: 'respond', agentId, title: agentLabel, summary: compact(assistantEventText(data)), responsePreview: compact(assistantEventText(data), 260), state: 'waiting', model: text(data.model) || undefined };
  if (assistantMode === 'stream') return { event, kind: 'agent', action: 'respond', agentId, title: agentLabel, summary: 'Streaming response', responsePreview: compact(assistantEventText(data)), state: 'running' };
  if (type.includes('step/start')) return { event, kind: 'checkpoint', action: 'start', agentId, title: 'Agent checkpoint', summary: 'Work step started', state: 'running' };
  if (type.includes('step/end') || type.includes('turn/end')) return { event, kind: 'checkpoint', action: 'complete', agentId, title: 'Checkpoint complete', summary: 'Work step completed', state: state ?? 'completed' };
  if (externalUrl) return { event, kind: 'external', action: 'read', agentId, title: safeHost(externalUrl), summary: compact(externalUrl), externalUrl };
  if (type.includes('turn/start') || type.includes('turn/end')) return { event, kind: 'checkpoint', action: type.includes('turn/start') ? 'start' : 'complete', agentId, title: type.includes('turn/start') ? 'Run started' : 'Run complete', summary: type.includes('turn/start') ? 'Agent run started' : 'Agent run completed', state: type.includes('turn/start') ? 'running' : state ?? 'completed', model: text(data.model) || undefined };
  if (type.includes('error')) return { event, kind: 'unknown', agentId, title: 'Unsupported event', summary: compact(text(data.error ?? data.message ?? event.type)), state: 'error' };
  return { event, kind: 'unknown', agentId, title: event.type, summary: compact(text(data.message ?? data.content ?? data)) };
}

function xForSeq(seq: number, start: number, end: number): number {
  if (start === end) return 0;
  return ((seq - start) / (end - start)) * 42 - 21;
}
function yForKind(kind: EventKind | SpatialEntity['kind']): number {
  if (kind === 'external') return 8;
  if (kind === 'tool') return 4;
  if (kind === 'file') return 2;
  if (kind === 'subagent') return -4;
  return 0;
}
function entityKey(kind: EventKind, value: string): string {
  return `${kind}:${value}`;
}
function ensureEntity(state: SpatialSceneState, entity: SpatialEntity): SpatialEntity {
  const existing = state.entities.get(entity.id);
  if (existing) return existing;
  state.entities.set(entity.id, entity);
  return entity;
}
function makeEntity(id: string, kind: SpatialEntity['kind'], label: string, seq: number, start: number, end: number, branchDepth = 0): SpatialEntity {
  const point: [number, number, number] = [xForSeq(seq, start, end), yForKind(kind), branchDepth * 5.5];
  return { id, kind, label, branchDepth, firstSeq: seq, lastSeq: seq, position: point, trail: [point], snapshots: [], metadata: {} };
}

function makeTrajectoryEvent({
  id, label, eventRole, agentId, seq, start, end, branchDepth, y, zOffset = 0, state, message,
}: {
  id: string;
  label: string;
  eventRole: NonNullable<SpatialEntity['eventRole']>;
  agentId: string;
  seq: number;
  start: number;
  end: number;
  branchDepth: number;
  y: number;
  zOffset?: number;
  state?: AgentState;
  message?: string;
}): SpatialEntity {
  return {
    id,
    kind: 'event',
    label,
    eventRole,
    message,
    ...(message !== undefined ? { messageHistory: [{ seq, content: message }] } : {}),
    branchDepth,
    state,
    firstSeq: seq,
    lastSeq: seq,
    position: [xForSeq(seq, start, end), y, branchDepth * 5.5 + zOffset],
    trail: [],
    snapshots: [],
    metadata: { agentId },
  };
}

function mergeAssistantText(current: string, incoming: string, streaming: boolean): string {
  if (!incoming) return current;
  if (!current || incoming.startsWith(current)) return incoming;
  if (current.endsWith(incoming) || current.includes(incoming)) return current;
  return streaming ? `${current}${incoming}` : `${current}\n${incoming}`;
}

function recordMessage(entity: SpatialEntity, seq: number, content: string, force = false): void {
  const unchanged = content === entity.message;
  if (unchanged && !force) return;
  entity.message = content;
  entity.lastSeq = seq;
  const history = entity.messageHistory ?? [];
  const latestSample = history.at(-1);
  if (force && latestSample?.seq === seq && latestSample.content === content) return;
  const sampledLength = latestSample?.content.length ?? 0;
  const firstVisibleContent = latestSample?.content === '' && content !== '';
  const shouldSample = force || !history.length || firstVisibleContent || Math.abs(content.length - sampledLength) >= 12;
  if (!shouldSample) return;
  history.push({ seq, content });
  if (history.length > MAX_MESSAGE_SAMPLES) {
    const first = history[0];
    const last = history.at(-1)!;
    entity.messageHistory = [first, ...history.slice(1, -1).filter((_, index) => index % 2 === 1), last];
  } else {
    entity.messageHistory = history;
  }
}
function addTrail(entity: SpatialEntity, seq: number, start: number, end: number): void {
  const point: [number, number, number] = [xForSeq(seq, start, end), yForKind(entity.kind), entity.branchDepth * 5.5];
  entity.lastSeq = seq;
  entity.position = point;
  const previous = entity.trail.at(-1);
  const minimumXSpacing = 42 / MAX_TRAIL_POINTS;
  if (!previous || seq === end || Math.abs(previous[0] - point[0]) >= minimumXSpacing) entity.trail.push(point);
}
function relation(state: SpatialSceneState, value: SpatialRelation): void {
  const existing = state.relations.get(value.id);
  if (existing) { existing.endSeq = value.endSeq ?? existing.endSeq; existing.state = value.state; return; }
  state.relations.set(value.id, value);
}

function sourceSeqs(raw: HarnessEvent): number[] {
  const sourceEventSeqs = object(raw.data).sourceEventSeqs;
  const linked = Array.isArray(sourceEventSeqs)
    ? sourceEventSeqs.filter((seq: unknown): seq is number => typeof seq === 'number')
    : [];
  return [...new Set([raw.seq, ...linked])].sort((left, right) => left - right);
}

function semanticActivityId(raw: HarnessEvent, normalized: NormalizedEvent): string {
  if (normalized.kind === 'tool' && normalized.callId) return `activity:tool:${normalized.callId}`;
  if (normalized.kind === 'agent') {
    const data = object(raw.data);
    const turn = typeof data.turn === 'number' || typeof data.turn === 'string' ? String(data.turn) : undefined;
    const step = typeof data.step === 'number' || typeof data.step === 'string' ? String(data.step) : undefined;
    if (turn !== undefined || step !== undefined) return `activity:agent:${raw.sessionId}:${normalized.agentId}:${turn ?? 'turn'}:${step ?? 'step'}`;
  }
  return `activity:${normalized.kind}:${raw.sessionId}:${raw.seq}`;
}

function linkActivityEntity(activity: SpatialActivity | undefined, entityId: string | undefined): void {
  if (activity && entityId && !activity.entityIds.includes(entityId)) activity.entityIds.push(entityId);
}

function recordActivity(state: SpatialSceneState, raw: HarnessEvent, normalized: NormalizedEvent, actorId: string): SpatialActivity | undefined {
  const type = raw.type.toLowerCase();
  const assistantMode = normalized.kind === 'agent' ? assistantEventMode(type, object(raw.data)) : undefined;
  if (normalized.kind === 'unknown' || (normalized.kind === 'agent' && !assistantMode)) return undefined;
  const id = semanticActivityId(raw, normalized);
  const existing = state.activities.get(id);
  const isToolResult = normalized.kind === 'tool' && type.includes('tool/result');
  const isStreamingReply = normalized.kind === 'agent' && assistantMode === 'stream';
  const isFinalReply = normalized.kind === 'agent' && assistantMode === 'message';
  const activity = existing ?? {
    id,
    kind: normalized.kind,
    action: normalized.action ?? 'observe',
    actorId,
    title: normalized.title,
    summary: normalized.summary,
    startSeq: raw.seq,
    sourceSeqs: [],
    sourceTypes: [],
    state: normalized.state,
    stateHistory: [],
    entityIds: [actorId],
  } satisfies SpatialActivity;

  activity.startSeq = Math.min(activity.startSeq, raw.seq);
  if (isToolResult || isFinalReply || type.includes('subagent/end') || type.includes('step/end') || type.includes('turn/end')) activity.endSeq = raw.seq;
  // A streamed answer can contain thousands of deltas. It remains a single
  // activity, anchored to its first visible delta and final transcript event,
  // rather than duplicating every token sequence in render state.
  const sourceSamples = isStreamingReply && existing ? [] : sourceSeqs(raw);
  for (const seq of sourceSamples) if (!activity.sourceSeqs.includes(seq)) activity.sourceSeqs.push(seq);
  activity.sourceSeqs.sort((left, right) => left - right);
  if (!activity.sourceTypes.includes(raw.type)) activity.sourceTypes.push(raw.type);
  // Result events often contain only a nested callId. Preserve the operation
  // identity from the call and only replace fields with more specific facts.
  if (!existing || (normalized.toolName && !activity.toolName)) activity.title = normalized.toolName ?? normalized.title;
  if (!existing || (!isToolResult && !isStreamingReply)) activity.summary = normalized.summary || activity.summary;
  activity.state = normalized.state ?? activity.state;
  activity.callId = normalized.callId ?? activity.callId;
  activity.toolName = normalized.toolName ?? activity.toolName;
  activity.filePath = normalized.filePath ?? activity.filePath;
  activity.externalUrl = normalized.externalUrl ?? activity.externalUrl;
  activity.inputPreview = normalized.inputPreview ?? activity.inputPreview;
  activity.outcomePreview = normalized.outcomePreview ?? activity.outcomePreview;
  if (!existing || !isToolResult || normalized.action !== 'execute') activity.action = normalized.action ?? activity.action;
  const currentSample = activity.stateHistory.at(-1);
  const sample = { seq: raw.seq, state: normalized.state ?? activity.state, summary: activity.summary, outcomePreview: normalized.outcomePreview };
  if (currentSample?.seq === raw.seq) Object.assign(currentSample, sample);
  else if (!isStreamingReply || !existing) activity.stateHistory.push(sample);
  state.activities.set(id, activity);
  return activity;
}

function isSemanticCheckpoint(raw: HarnessEvent, normalized: NormalizedEvent): boolean {
  const type = raw.type.toLowerCase();
  const data = object(raw.data);
  if (normalized.state === 'error' || type.includes('error')) return true;
  if (normalized.kind === 'prompt' || normalized.kind === 'file' || normalized.kind === 'subagent' || normalized.kind === 'tool' || normalized.kind === 'external') return true;
  if (normalized.kind === 'agent') return assistantEventMode(type, data) === 'message';
  return type.includes('turn/start') || type.includes('step/end') || type.includes('turn/end');
}

function lifecycleKey(normalized: NormalizedEvent): string | undefined {
  if (normalized.kind === 'tool' && normalized.callId) return `tool:${normalized.callId}`;
  return undefined;
}

function burstKey(normalized: NormalizedEvent, agentId: string): string | undefined {
  if (normalized.kind === 'file' && normalized.filePath) return `file:${agentId}:${normalized.filePath}`;
  if (normalized.kind === 'external' && normalized.externalUrl) return `external:${agentId}:${normalized.externalUrl}`;
  return undefined;
}

function checkpointPriority(checkpoint: SpatialCheckpoint): number {
  if (checkpoint.state === 'error') return 6;
  if (checkpoint.kind === 'prompt' || checkpoint.kind === 'file' || checkpoint.kind === 'subagent') return 5;
  if (checkpoint.kind === 'agent') return 4;
  if (checkpoint.kind === 'tool') return 3;
  if (checkpoint.kind === 'checkpoint') return 2;
  return 1;
}

/** Keep navigation bounded without deleting the underlying Harness event history. */
function capTimeline(checkpoints: SpatialCheckpoint[]): SpatialCheckpoint[] {
  if (checkpoints.length <= MAX_TIMELINE_CHECKPOINTS) return checkpoints;
  const sampled: SpatialCheckpoint[] = [];
  for (let bucketIndex = 0; bucketIndex < MAX_TIMELINE_CHECKPOINTS; bucketIndex += 1) {
    const start = Math.floor((bucketIndex * checkpoints.length) / MAX_TIMELINE_CHECKPOINTS);
    const end = Math.floor(((bucketIndex + 1) * checkpoints.length) / MAX_TIMELINE_CHECKPOINTS);
    const bucket = checkpoints.slice(start, Math.max(start + 1, end));
    let chosen = bucket[0];
    for (const checkpoint of bucket.slice(1)) {
      if (checkpointPriority(checkpoint) > checkpointPriority(chosen)
        || (checkpointPriority(checkpoint) === checkpointPriority(chosen) && checkpoint.seq > chosen.seq)) chosen = checkpoint;
    }
    sampled.push(chosen);
  }
  // The first prompt and latest state are useful anchors even when a bucket is dense.
  sampled[0] = checkpoints[0];
  sampled[sampled.length - 1] = checkpoints.at(-1)!;
  return sampled;
}

export function createEmptyScene(sessionId: string): SpatialSceneState {
  return {
    sessionId,
    entities: new Map(),
    relations: new Map(),
    activities: new Map(),
    checkpoints: [],
    events: [],
    cursorSeq: 0,
    range: { startSeq: 0, endSeq: 0, hasOlder: false },
    live: { running: true, tailSeq: 0, newEvents: 0 },
    issues: [],
    stations: [],
    layout: { startX: 0, endX: 0, seqX: new Map(), seqOrder: [] },
  };
}

export function projectEvents(events: HarnessEvent[], previous?: SpatialSceneState): SpatialSceneState {
  if (previous) {
    const merged = new Map<string, HarnessEvent>();
    for (const event of previous.events) merged.set(`${event.sessionId}:${event.seq}`, event);
    for (const event of events) merged.set(`${event.sessionId}:${event.seq}`, event);
    return projectEvents([...merged.values()]);
  }
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const sessionId = sorted[0]?.sessionId ?? 'empty-session';
  const state = createEmptyScene(sessionId);
  const start = sorted[0]?.seq ?? state.range.startSeq ?? 0;
  const end = sorted.at(-1)?.seq ?? state.range.endSeq ?? start;
  const seen = new Set<string>();
  const checkpointsByLifecycle = new Map<string, SpatialCheckpoint>();
  const checkpointsByBurst = new Map<string, SpatialCheckpoint>();
  const fileActivity = new Map<string, { reads: number; writes: number; agents: Set<string> }>();
  const currentRunByAgent = new Map<string, { startSeq: number }>();
  const currentStepByAgent = new Map<string, string>();
  const assistantSegments = new Map<string, SpatialEntity>();
  const main = ensureEntity(state, makeEntity('agent-main', 'agent', 'Main Agent', start, start, end, 0));
  main.state = 'waiting';

  const beginAgentRun = (agent: SpatialEntity, seq: number): { startSeq: number } => {
    const agentId = agent.id;
    const y = agent.kind === 'subagent' ? -4 : 0;
    const startEntity = makeTrajectoryEvent({
      id: `event:start:${sessionId}:${agentId}:${seq}`,
      label: agent.kind === 'subagent' ? 'Subagent started' : 'Agent started',
      eventRole: 'agent-start',
      agentId,
      seq,
      start,
      end,
      branchDepth: agent.branchDepth,
      y,
      state: 'running',
    });
    state.entities.set(startEntity.id, startEntity);
    const run = { startSeq: seq };
    currentRunByAgent.set(agentId, run);
    return run;
  };

  const stepKey = (agentId: string, data: Record<string, unknown>, seq: number, mode: AssistantEventMode): string => {
    const turn = typeof data.turn === 'number' || typeof data.turn === 'string' ? String(data.turn) : undefined;
    const step = typeof data.step === 'number' || typeof data.step === 'string' ? String(data.step) : undefined;
    if (turn !== undefined || step !== undefined) return `${agentId}:${turn ?? 'turn'}:${step ?? 'step'}`;
    const current = currentStepByAgent.get(agentId);
    if (current) return current;
    const fallback = `${agentId}:${mode === 'stream' ? 'stream' : 'message'}:${seq}`;
    if (mode === 'stream') currentStepByAgent.set(agentId, fallback);
    return fallback;
  };

  const updateAssistantSegment = (agent: SpatialEntity, data: Record<string, unknown>, seq: number, mode: AssistantEventMode, content: string): SpatialEntity | undefined => {
    const key = stepKey(agent.id, data, seq, mode);
    if (!content) {
      if (mode === 'message') currentStepByAgent.delete(agent.id);
      return undefined;
    }
    const y = agent.kind === 'subagent' ? -4 : 0;
    let entity = assistantSegments.get(key);
    if (!entity) {
      entity = makeTrajectoryEvent({
        id: `event:assistant:${sessionId}:${key}`,
        label: agent.kind === 'subagent' ? 'Subagent response' : 'Agent response',
        eventRole: 'assistant-message',
        agentId: agent.id,
        seq,
        start,
        end,
        branchDepth: agent.branchDepth,
        y: y + 0.35,
        zOffset: 2.2,
        state: mode === 'stream' ? 'running' : 'completed',
        message: '',
      });
      assistantSegments.set(key, entity);
      state.entities.set(entity.id, entity);
    }
    // The finalized assistant/message is the exact transcript value. It replaces
    // provisional chunks instead of being concatenated with them.
    const merged = mode === 'message' ? content : mergeAssistantText(entity.message ?? '', content, true);
    recordMessage(entity, seq, merged, mode === 'message');
    // The visible feedback belongs at the end of this small trajectory segment,
    // not at the run-start marker.
    entity.position = [xForSeq(seq, start, end), entity.position[1], entity.position[2]];
    entity.lastSeq = seq;
    entity.state = mode === 'stream' ? 'running' : 'completed';
    if (mode === 'message') currentStepByAgent.delete(agent.id);
    return entity;
  };

  const endAgentRun = (agent: SpatialEntity, seq: number, resultState: AgentState = 'completed'): void => {
    const y = agent.kind === 'subagent' ? -4 : 0;
    const endEntity = makeTrajectoryEvent({
      id: `event:end:${sessionId}:${agent.id}:${seq}`,
      label: agent.kind === 'subagent' ? 'Subagent completed' : 'Agent completed',
      eventRole: 'agent-end',
      agentId: agent.id,
      seq,
      start,
      end,
      branchDepth: agent.branchDepth,
      y,
      state: resultState,
    });
    state.entities.set(endEntity.id, endEntity);
    currentRunByAgent.delete(agent.id);
    currentStepByAgent.delete(agent.id);
  };
  for (const raw of sorted) {
    const eventId = `${raw.sessionId}:${raw.seq}`;
    if (seen.has(eventId)) continue;
    seen.add(eventId);
    state.events.push(raw);
    const normalized = normalizeEvent(raw);
    const rawType = raw.type.toLowerCase();
    const xStart = start || raw.seq;
    const xEnd = end || raw.seq;
    const data = object(raw.data);
    let actor = normalized.agentId === 'agent-main' ? main : state.entities.get(normalized.agentId);
    if (!actor && normalized.kind === 'subagent') actor = ensureEntity(state, makeEntity(normalized.agentId, 'subagent', normalized.title, raw.seq, xStart, xEnd, 1));
    if (!actor) actor = main;
    if (normalized.kind === 'subagent') {
      actor = ensureEntity(state, makeEntity(normalized.agentId, 'subagent', normalized.title, raw.seq, xStart, xEnd, actor.branchDepth || 1));
      actor.parentAgentId = normalized.parentAgentId;
      actor.task = normalized.task ?? actor.task;
      actor.model = normalized.model ?? actor.model;
      actor.state = normalized.state ?? actor.state;
      addTrail(actor, raw.seq, xStart, xEnd);
      if (raw.type.includes('/start')) relation(state, { id: `delegate:${normalized.parentAgentId ?? 'agent-main'}:${actor.id}`, kind: 'delegate', sourceId: normalized.parentAgentId ?? 'agent-main', targetId: actor.id, startSeq: raw.seq, state: 'active', label: actor.task });
      if (raw.type.includes('/end')) {
        const delegate = state.relations.get(`delegate:${normalized.parentAgentId ?? 'agent-main'}:${actor.id}`);
        if (delegate) { delegate.endSeq = raw.seq; delegate.state = normalized.state === 'error' ? 'error' : 'completed'; }
      }
    } else {
      actor.state = normalized.state ?? (normalized.kind === 'tool' ? 'running' : actor.state);
      actor.model = normalized.model ?? actor.model;
      addTrail(actor, raw.seq, xStart, xEnd);
    }
    const activity = recordActivity(state, raw, normalized, actor.id);
    linkActivityEntity(activity, actor.id);
    if (normalized.kind === 'tool') {
      const toolId = entityKey('tool', normalized.callId ?? `${normalized.toolName ?? normalized.title}:${raw.seq}`);
      const tool = ensureEntity(state, makeEntity(toolId, 'tool', normalized.toolName ?? normalized.title, raw.seq, xStart, xEnd));
      tool.toolName = normalized.toolName ?? tool.toolName;
      if (tool.label === 'Tool result' && normalized.toolName) tool.label = normalized.toolName;
      tool.state = normalized.state;
      tool.path = normalized.filePath ?? activity?.filePath ?? tool.path;
      addTrail(tool, raw.seq, xStart, xEnd);
      linkActivityEntity(activity, tool.id);
      if (normalized.callId) {
        const relId = `tool:${normalized.callId}`;
        const isResult = raw.type.includes('/result');
        relation(state, { id: relId, kind: 'tool-call', sourceId: actor.id, targetId: tool.id, startSeq: state.relations.get(relId)?.startSeq ?? raw.seq, endSeq: isResult ? raw.seq : undefined, state: normalized.state === 'error' ? 'error' : isResult ? 'completed' : 'active', label: normalized.callId });
      }
    }
    const activityFilePath = normalized.filePath ?? activity?.filePath;
    if (activityFilePath) {
      const fileId = entityKey('file', activityFilePath);
      const file = ensureEntity(state, makeEntity(fileId, 'file', activityFilePath, raw.seq, xStart, xEnd));
      file.path = activityFilePath;
      addTrail(file, raw.seq, xStart, xEnd);
      linkActivityEntity(activity, file.id);
      const isWrite = activity?.action === 'write' || /edit|write|patch|snapshot/i.test(normalized.toolName ?? raw.type) || normalized.kind === 'file';
      const fileUsage = fileActivity.get(fileId) ?? { reads: 0, writes: 0, agents: new Set<string>() };
      if (isWrite) fileUsage.writes += 1;
      else fileUsage.reads += 1;
      fileUsage.agents.add(actor.id);
      fileActivity.set(fileId, fileUsage);
      const relId = `${isWrite ? 'write' : 'read'}:${actor.id}:${file.id}:${raw.seq}`;
      relation(state, { id: relId, kind: isWrite ? 'write' : 'read', sourceId: isWrite ? actor.id : file.id, targetId: isWrite ? file.id : actor.id, startSeq: raw.seq, endSeq: raw.seq, state: normalized.state === 'error' ? 'error' : 'completed', label: activityFilePath });
      if (normalized.kind === 'file' || (isWrite && raw.type.includes('file/'))) {
        const snapshotId = `snapshot:${activityFilePath}:${raw.seq}`;
        if (!file.snapshots.some((snapshot) => snapshot.id === snapshotId)) file.snapshots.push({
          id: snapshotId,
          fileId,
          path: activityFilePath,
          seq: raw.seq,
          timestamp: raw.timestamp,
          exact: normalized.exactSnapshot === true,
          ...(normalized.snapshotContent ? { contentRef: `inline:${snapshotId}`, content: normalized.snapshotContent } : {}),
          change: normalized.snapshotChange,
        });
      }
    }
    if (normalized.externalUrl) {
      const host = safeHost(normalized.externalUrl);
      const external = ensureEntity(state, makeEntity(entityKey('external', host), 'external', host, raw.seq, xStart, xEnd));
      external.url = normalized.externalUrl;
      addTrail(external, raw.seq, xStart, xEnd);
      linkActivityEntity(activity, external.id);
      relation(state, { id: `external:${raw.seq}`, kind: 'read', sourceId: actor.id, targetId: external.id, startSeq: raw.seq, endSeq: raw.seq, state: 'completed' });
    }
    if (isUserMessageEvent(rawType, data)) {
      const message = isAppendSurfaceMessage(data) ? userVisibleText(data) : '';
      if (message) {
        const userEntity = makeTrajectoryEvent({
          id: `event:user:${raw.sessionId}:${raw.seq}`,
          label: 'User message',
          eventRole: 'user-message',
          agentId: 'agent-main',
          seq: raw.seq,
          start: xStart,
          end: xEnd,
          branchDepth: 0,
          y: 1.25,
          zOffset: -2.2,
          state: 'completed',
          message,
        });
        state.entities.set(userEntity.id, userEntity);
        linkActivityEntity(activity, userEntity.id);
      }
    }
    if (rawType.includes('turn/start') || rawType.includes('subagent/start')) beginAgentRun(actor, raw.seq);
    if (rawType.includes('step/start')) {
      const turn = typeof data.turn === 'number' || typeof data.turn === 'string' ? String(data.turn) : 'turn';
      const step = typeof data.step === 'number' || typeof data.step === 'string' ? String(data.step) : String(raw.seq);
      currentStepByAgent.set(actor.id, `${actor.id}:${turn}:${step}`);
    }
    const assistantMode = assistantEventMode(rawType, data);
    if (assistantMode) {
      if (!currentRunByAgent.has(actor.id)) beginAgentRun(actor, raw.seq);
      const incoming = assistantMode === 'message' && !isAppendSurfaceMessage(data) ? '' : assistantEventText(data);
      const responseEntity = updateAssistantSegment(actor, data, raw.seq, assistantMode, incoming);
      linkActivityEntity(activity, responseEntity?.id);
    }
    if (rawType.includes('step/end')) currentStepByAgent.delete(actor.id);
    if (rawType.includes('turn/end') || rawType.includes('subagent/end')) {
      endAgentRun(actor, raw.seq, normalized.state === 'error' ? 'error' : 'completed');
    }
    if (isSemanticCheckpoint(raw, normalized)) {
      const checkpoint: SpatialCheckpoint = {
        id: `checkpoint:${raw.sessionId}:${raw.seq}`,
        seq: raw.seq,
        timestamp: raw.timestamp,
        agentId: actor.id,
        kind: normalized.kind,
        title: activity?.title ?? normalized.title,
        summary: activity?.summary ?? normalized.summary,
        state: activity?.state ?? normalized.state,
        eventType: raw.type,
        responsePreview: normalized.responsePreview,
        toolCalls: normalized.callId ? [normalized.callId] : [],
        action: activity?.action ?? normalized.action,
        outcomePreview: activity?.outcomePreview ?? normalized.outcomePreview,
        activityId: activity?.id,
        sourceSeqs: activity ? [...activity.sourceSeqs] : sourceSeqs(raw),
      };
      const lifecycle = lifecycleKey(normalized);
      const burst = burstKey(normalized, actor.id);
      const lifecycleCheckpoint = lifecycle ? checkpointsByLifecycle.get(lifecycle) : undefined;
      const burstCheckpoint = burst ? checkpointsByBurst.get(burst) : undefined;
      const burstAge = checkpoint.timestamp != null && burstCheckpoint?.timestamp != null
        ? checkpoint.timestamp - burstCheckpoint.timestamp
        : undefined;
      const canMergeBurst = burstAge != null && burstAge >= 0 && burstAge <= BURST_WINDOW_MS;
      const existing = lifecycleCheckpoint ?? (canMergeBurst ? burstCheckpoint : undefined);
      if (existing) {
        existing.seq = checkpoint.seq;
        existing.timestamp = checkpoint.timestamp;
        existing.title = checkpoint.title || existing.title;
        existing.summary = checkpoint.summary || existing.summary;
        existing.state = checkpoint.state ?? existing.state;
        existing.eventType = checkpoint.eventType;
        existing.responsePreview = checkpoint.responsePreview ?? existing.responsePreview;
        existing.action = checkpoint.action ?? existing.action;
        existing.outcomePreview = checkpoint.outcomePreview ?? existing.outcomePreview;
        existing.activityId = checkpoint.activityId ?? existing.activityId;
        existing.sourceSeqs = checkpoint.sourceSeqs ?? existing.sourceSeqs;
        for (const callId of checkpoint.toolCalls) if (!existing.toolCalls.includes(callId)) existing.toolCalls.push(callId);
      } else {
        state.checkpoints.push(checkpoint);
        if (lifecycle) checkpointsByLifecycle.set(lifecycle, checkpoint);
        if (burst) checkpointsByBurst.set(burst, checkpoint);
      }
      if (lifecycle && existing) checkpointsByLifecycle.set(lifecycle, existing);
      if (burst && existing) checkpointsByBurst.set(burst, existing);
    }
    if (normalized.kind === 'unknown') state.issues.push(`${raw.type} at seq ${raw.seq}`);
    state.cursorSeq = raw.seq;
  }
  const rankedFiles = [...fileActivity.entries()]
    .map(([fileId, activity]) => ({
      fileId,
      activity,
      score: activity.reads + activity.writes * 3 + activity.agents.size * 0.75,
    }))
    .sort((left, right) => right.score - left.score || left.fileId.localeCompare(right.fileId));
  const qualifiedFiles = rankedFiles.filter(({ activity }) => activity.writes > 0 || activity.reads + activity.writes >= 2);
  const landmarkCandidates = [...qualifiedFiles];
  for (const candidate of rankedFiles) {
    if (landmarkCandidates.some(({ fileId }) => fileId === candidate.fileId)) continue;
    landmarkCandidates.push(candidate);
    if (landmarkCandidates.length >= Math.min(8, rankedFiles.length)) break;
  }
  const landmarks = new Set(landmarkCandidates.slice(0, MAX_FILE_LANDMARKS).map(({ fileId }) => fileId));
  for (const { fileId, activity, score } of rankedFiles) {
    const file = state.entities.get(fileId);
    if (!file) continue;
    file.importance = score;
    file.metadata.landmark = landmarks.has(fileId) ? 'true' : 'false';
    file.metadata.reads = String(activity.reads);
    file.metadata.writes = String(activity.writes);
    file.metadata.agents = String(activity.agents.size);
  }

  state.events.sort((a, b) => a.seq - b.seq);
  state.checkpoints.sort((a, b) => a.seq - b.seq);
  state.checkpoints = capTimeline(state.checkpoints);
  state.range = { startSeq: state.events[0]?.seq ?? 0, endSeq: state.events.at(-1)?.seq ?? 0, hasOlder: false };
  state.live.tailSeq = state.range.endSeq;
  state.live.newEvents = 0;
  applyStationLayout(state);
  return state;
}

export function entityAtCursor(entity: SpatialEntity, cursorSeq: number): boolean {
  return entity.firstSeq <= cursorSeq && (entity.kind !== 'file' || entity.metadata.landmark !== 'false');
}
export function entitiesAtCursor(state: SpatialSceneState, cursorSeq: number): SpatialEntity[] {
  const visible = [...state.entities.values()].filter((entity) => entityAtCursor(entity, cursorSeq));
  return visible.map((entity) => {
    if (!entity.messageHistory?.length) return entity;
    const sample = [...entity.messageHistory].reverse().find((entry) => entry.seq <= cursorSeq);
    const message = sample?.content ?? '';
    const position: SpatialEntity['position'] = entity.eventRole === 'assistant-message' && sample
      ? [entity.position[0], entity.position[1], state.layout.seqX.get(sample.seq) ?? entity.position[2]]
      : entity.position;
    return { ...entity, position, message, metadata: { ...entity.metadata, bubbleVisible: String(Boolean(message.trim())) } };
  });
}
export function relationsAtCursor(state: SpatialSceneState, cursorSeq: number): SpatialRelation[] { return [...state.relations.values()].filter((relation) => relation.startSeq <= cursorSeq); }

/** Recover the exact raw Harness records behind a compact semantic activity. */
export function sourceEventsForActivity(state: SpatialSceneState, activity: SpatialActivity): HarnessEvent[] {
  const seqs = new Set(activity.sourceSeqs);
  return state.events.filter((event) => seqs.has(event.seq));
}

function replayActivityAt(activity: SpatialActivity, cursorSeq: number): SpatialActivity | undefined {
  const sample = [...activity.stateHistory].reverse().find((entry) => entry.seq <= cursorSeq);
  if (!sample) return undefined;
  return {
    ...activity,
    sourceSeqs: activity.sourceSeqs.filter((seq) => seq <= cursorSeq),
    state: sample.state,
    summary: sample.summary ?? activity.summary,
    outcomePreview: sample.outcomePreview,
  };
}

/** The semantic event currently nearest to the cursor, preferring concrete work over structural checkpoints. */
export function activityAtCursor(state: SpatialSceneState, cursorSeq: number): SpatialActivity | undefined {
  const activities = [...state.activities.values()]
    .map((activity) => replayActivityAt(activity, cursorSeq))
    .filter((activity): activity is SpatialActivity => Boolean(activity));
  const concrete = activities.filter((activity) => activity.kind !== 'checkpoint');
  const candidates = concrete.length ? concrete : activities;
  return candidates.sort((left, right) => {
    const leftSeq = left.stateHistory.filter((entry) => entry.seq <= cursorSeq).at(-1)?.seq ?? left.startSeq;
    const rightSeq = right.stateHistory.filter((entry) => entry.seq <= cursorSeq).at(-1)?.seq ?? right.startSeq;
    return rightSeq - leftSeq || right.startSeq - left.startSeq;
  })[0];
}

/** The cursor-aware activity for an entity; unlike a global “latest activity”, it never leaks future work into replay. */
export function latestActivityForEntity(state: SpatialSceneState, entityId: string, cursorSeq = state.cursorSeq): SpatialActivity | undefined {
  const activities = [...state.activities.values()]
    .filter((activity) => activity.entityIds.includes(entityId))
    .map((activity) => replayActivityAt(activity, cursorSeq))
    .filter((activity): activity is SpatialActivity => Boolean(activity));
  return activities.sort((left, right) => {
    const leftSeq = left.stateHistory.filter((entry) => entry.seq <= cursorSeq).at(-1)?.seq ?? left.startSeq;
    const rightSeq = right.stateHistory.filter((entry) => entry.seq <= cursorSeq).at(-1)?.seq ?? right.startSeq;
    return rightSeq - leftSeq || right.startSeq - left.startSeq;
  })[0];
}
