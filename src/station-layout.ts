import type { HarnessEvent, SpatialEntity, SpatialRelation, SpatialSceneState, SpatialStation } from './types';

const STATION_GAP = 7;
const MIN_STATION_WIDTH = 22;
const MAX_STATION_WIDTH = 46;

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

function isHumanMessage(event: HarnessEvent): boolean {
  const type = event.type.toLowerCase();
  const data = object(event.data);
  const isUserMessage = type.includes('user/message') || (type.includes('message/') && typeof data.role === 'string' && data.role.toLowerCase() === 'user');
  if (!isUserMessage) return false;
  const source = object(data.source);
  const append = data.surfaceOp === undefined || data.surfaceOp === 'append';
  return append && (!Object.keys(source).length || source.kind === 'user');
}

function eventWeight(event: HarnessEvent): number {
  const type = event.type.toLowerCase();
  const data = object(event.data);
  if (type.includes('assistant/chunk')) {
    const chunk = object(data.chunk);
    return chunk.type === 'text-delta' ? 0.12 : 0;
  }
  if (type.includes('user/message')) return isHumanMessage(event) ? 2.8 : 0;
  if (type.includes('assistant/message')) return 3.2;
  if (type.includes('tool/call')) return 2.1;
  if (type.includes('tool/result')) return 0.9;
  if (type.includes('subagent/start') || type.includes('subagent/end')) return 2.2;
  if (type.includes('file/')) return 1.4;
  if (type.includes('step/start') || type.includes('step/end')) return 0.8;
  if (type.includes('turn/start') || type.includes('turn/end')) return 1;
  if (type.includes('error')) return 1.5;
  return 0.08;
}

type DraftStation = {
  id: string;
  turn?: string;
  startSeq: number;
  endSeq: number;
};

function buildDraftStations(events: HarnessEvent[]): DraftStation[] {
  const stations: DraftStation[] = [];
  const pendingUsers: HarnessEvent[] = [];
  let current: DraftStation | undefined;
  const openStation = (event: HarnessEvent): DraftStation => {
    const data = object(event.data);
    const turn = typeof data.turn === 'number' || typeof data.turn === 'string' ? String(data.turn) : undefined;
    const pending = pendingUsers.splice(0);
    const startSeq = pending[0]?.seq ?? event.seq;
    const station: DraftStation = {
      id: `station:${event.sessionId}:${turn ?? event.seq}`,
      turn,
      startSeq,
      endSeq: event.seq,
    };
    stations.push(station);
    return station;
  };

  for (const event of events) {
    const type = event.type.toLowerCase();
    if (isHumanMessage(event) && !current) pendingUsers.push(event);
    if (type.includes('turn/start')) current = openStation(event);
    if (!current && !type.includes('turn/start') && !isHumanMessage(event) && pendingUsers.length) {
      current = openStation(pendingUsers[0]);
    }
    if (current) {
      current.endSeq = event.seq;
    }
    if (type.includes('turn/end') && current) current = undefined;
  }

  if (!stations.length && events.length) {
    stations.push({
      id: `station:${events[0].sessionId}:fallback`,
      startSeq: events[0].seq,
      endSeq: events.at(-1)!.seq,
    });
  } else if (pendingUsers.length) {
    for (const event of pendingUsers) {
      stations.push({ id: `station:${event.sessionId}:message:${event.seq}`, startSeq: event.seq, endSeq: event.seq });
    }
  }
  return stations;
}

function stationForSeq(stations: SpatialStation[], seq: number): SpatialStation | undefined {
  let low = 0;
  let high = stations.length - 1;
  let previous: SpatialStation | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const station = stations[middle];
    if (seq < station.startSeq) high = middle - 1;
    else if (seq > station.endSeq) { previous = station; low = middle + 1; }
    else return station;
  }
  return previous ?? stations[0];
}

function relationTouchesFile(relation: SpatialRelation, fileId: string): boolean {
  return relation.sourceId === fileId || relation.targetId === fileId;
}

function xForSeq(state: SpatialSceneState, seq: number): number {
  const exact = state.layout.seqX.get(seq);
  if (exact !== undefined) return exact;
  const order = state.layout.seqOrder;
  let low = 0;
  let high = order.length - 1;
  let previous = order[0];
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = order[middle];
    if (candidate <= seq) { previous = candidate; low = middle + 1; }
    else high = middle - 1;
  }
  return previous === undefined ? 0 : state.layout.seqX.get(previous) ?? 0;
}

function setStationMetadata(entity: SpatialEntity, station: SpatialStation | undefined): void {
  if (!station || entity.kind === 'file') return;
  entity.metadata.stationId = station.id;
  if (!station.entityIds.includes(entity.id)) station.entityIds.push(entity.id);
}

/** Deterministic time corridor: causal lanes on X, information layers on Y, semantic time on Z. */
export function applyStationLayout(state: SpatialSceneState): void {
  const drafts = buildDraftStations(state.events);
  const eventsByDraft = drafts.map(() => [] as HarnessEvent[]);
  let draftIndex = 0;
  for (const event of state.events) {
    while (draftIndex < drafts.length - 1 && event.seq > drafts[draftIndex].endSeq) draftIndex += 1;
    const draft = drafts[draftIndex];
    if (draft && draft.startSeq <= event.seq && event.seq <= draft.endSeq) eventsByDraft[draftIndex].push(event);
  }
  let cursorX = 0;
  const stations: SpatialStation[] = drafts.map((draft, index) => {
    const events = eventsByDraft[index];
    const tools = events.filter((event) => event.type.toLowerCase().includes('tool/call')).length;
    const responses = events.filter((event) => event.type.toLowerCase().includes('assistant/message')).length;
    const branches = events.filter((event) => event.type.toLowerCase().includes('subagent/start')).length;
    const complexity = tools + responses * 1.5 + branches * 2;
    const width = clamp(MIN_STATION_WIDTH + Math.min(tools, 8) * 1.8 + Math.min(responses, 4) * 2.6 + Math.min(branches, 3) * 3, MIN_STATION_WIDTH, MAX_STATION_WIDTH);
    const startX = cursorX;
    const endX = startX + width;
    cursorX = endX + STATION_GAP;
    return {
      id: draft.id,
      index,
      turn: draft.turn,
      startSeq: draft.startSeq,
      endSeq: draft.endSeq,
      startX,
      endX,
      centerX: (startX + endX) / 2,
      complexity,
      entityIds: [],
      userEntityIds: [],
      responseEntityIds: [],
      toolEntityIds: [],
      fileEntityIds: [],
    };
  });

  const seqX = new Map<number, number>();
  for (const station of stations) {
    const events = eventsByDraft[station.index];
    const total = events.reduce((sum, event) => sum + eventWeight(event), 0) || 1;
    let progress = 0;
    for (const event of events) {
      const weight = eventWeight(event);
      const inset = 2.2;
      seqX.set(event.seq, station.startX + inset + ((progress + weight * 0.5) / total) * Math.max(1, station.endX - station.startX - inset * 2));
      progress += weight;
    }
  }
  state.stations = stations;
  state.layout = { startX: stations[0]?.startX ?? 0, endX: stations.at(-1)?.endX ?? 0, seqX, seqOrder: [...seqX.keys()].sort((left, right) => left - right) };

  const entities = [...state.entities.values()];
  const entitiesByStation = new Map<string, SpatialEntity[]>();
  for (const entity of entities) {
    const station = stationForSeq(stations, entity.firstSeq);
    setStationMetadata(entity, station);
    if (station && entity.kind !== 'file') {
      const bucket = entitiesByStation.get(station.id) ?? [];
      bucket.push(entity);
      entitiesByStation.set(station.id, bucket);
    }
  }

  for (const station of stations) {
    const local = entitiesByStation.get(station.id) ?? [];
    const users = local.filter((entity) => entity.eventRole === 'user-message').sort((a, b) => a.firstSeq - b.firstSeq);
    const responses = local.filter((entity) => entity.eventRole === 'assistant-message').sort((a, b) => a.firstSeq - b.firstSeq);
    const tools = local.filter((entity) => entity.kind === 'tool').sort((a, b) => a.firstSeq - b.firstSeq);
    station.userEntityIds = users.map((entity) => entity.id);
    station.responseEntityIds = responses.map((entity) => entity.id);
    station.toolEntityIds = tools.map((entity) => entity.id);

    users.forEach((entity, index) => {
      entity.position = [-7.4 - index * 1.2, 1.2 + index * 0.42, xForSeq(state, entity.firstSeq)];
    });
    responses.forEach((entity, index) => {
      entity.position = [7.2 + (index % 2) * 1.3, 1.35 + (index % 3) * 0.4, xForSeq(state, entity.lastSeq)];
    });
    tools.forEach((entity, index) => {
      // A tool is a reachable workstation, not a bead on a lower rail.  These
      // deliberately irregular slots make the Agent's cross-section movement
      // legible while preserving the semantic-time ordering along Z.
      const workbenchSlots: Array<[number, number]> = [
        [-5.1, -0.7], [-3.3, 1.8], [-1.1, -1.9], [1.6, 2.15],
        [4.0, 0.25], [5.4, -1.25], [2.6, -2.25], [-2.2, 0.35],
      ];
      const inset = 5;
      const usableWidth = Math.max(1, station.endX - station.startX - inset * 2);
      const z = tools.length === 1 ? station.centerX : station.startX + inset + (index / (tools.length - 1)) * usableWidth;
      const [baseX, baseY] = workbenchSlots[index % workbenchSlots.length];
      const shell = Math.floor(index / workbenchSlots.length);
      entity.position = [baseX + (shell % 2 ? 0.46 : -0.46), baseY + shell * 0.42, z];
      entity.metadata.toolDensity = String(tools.length);
      entity.metadata.labelVisible = String(tools.length <= 10 || index % Math.max(1, Math.ceil(tools.length / 8)) === 0);
    });
    local.filter((entity) => entity.kind === 'external').forEach((entity, index) => {
      entity.position = [-10.5 - index * 2.4, 4.8, xForSeq(state, entity.firstSeq)];
      entity.metadata.labelVisible = 'true';
    });
    local.filter((entity) => entity.kind === 'subagent').forEach((entity, index) => {
      entity.position = [9 + entity.branchDepth * 3.8 + index * 2.2, -0.35, xForSeq(state, entity.lastSeq)];
    });
    local.filter((entity) => entity.kind === 'event' && entity.eventRole !== 'user-message' && entity.eventRole !== 'assistant-message').forEach((entity) => {
      const branchX = entity.metadata.agentId === 'agent-main' ? 0 : 10 + entity.branchDepth * 3.8;
      entity.position = [branchX, -0.35, xForSeq(state, entity.firstSeq)];
    });
  }

  const main = state.entities.get('agent-main');
  if (main) {
    main.trail = stations.flatMap((station) => [
      [0, -0.55, station.startX + 1] as [number, number, number],
      [0, -0.85, station.centerX] as [number, number, number],
      [0, -0.55, station.endX - 1] as [number, number, number],
    ]);
    main.position = main.trail.at(-1) ?? [0, -0.7, 0];
  }

  const files = entities.filter((entity) => entity.kind === 'file' && entity.metadata.landmark !== 'false')
    .sort((left, right) => (right.importance ?? 0) - (left.importance ?? 0));
  files.forEach((file, index) => {
    const accesses = [...state.relations.values()].filter((relation) => relationTouchesFile(relation, file.id));
    const accessX = accesses.map((relation) => xForSeq(state, relation.startSeq));
    const averageX = accessX.length ? accessX.reduce((sum, value) => sum + value, 0) / accessX.length : state.layout.endX;
    // Files form a side constellation around the time corridor.  It keeps
    // artifacts distinct from transient tool work while making writes and
    // reads visible as directed reach-out motions rather than vertical jumps.
    const constellationSlots: Array<[number, number]> = [
      [-8.6, 3.2], [-5.5, 5.0], [-2.0, 4.25], [1.9, 5.5], [5.4, 3.85],
      [8.1, 1.65], [5.6, 0.8], [1.5, 2.55], [-3.1, 2.3], [-6.4, 1.15],
    ];
    const [baseX, baseY] = constellationSlots[index % constellationSlots.length];
    const ring = Math.floor(index / constellationSlots.length);
    file.position = [baseX * (1 + ring * 0.1), baseY + ring * 0.75, averageX];
    file.metadata.labelVisible = String(index < 8);
    const touched = new Set(accesses.map((relation) => stationForSeq(stations, relation.startSeq)?.id).filter(Boolean) as string[]);
    for (const stationId of touched) {
      const station = stations.find((item) => item.id === stationId);
      if (station && !station.fileEntityIds.includes(file.id)) station.fileEntityIds.push(file.id);
    }
  });

  // Re-anchor actor-owned relations to the local station hub, so historical
  // tool and file edges do not all originate from the latest Main Agent node.
  for (const relation of state.relations.values()) {
    const station = stationForSeq(stations, relation.startSeq);
    if (!station) continue;
    const hub = station.entityIds.map((id) => state.entities.get(id)).find((entity) => entity?.eventRole === 'agent-start' && entity.metadata.agentId === 'agent-main');
    if (!hub) continue;
    if (relation.sourceId === 'agent-main') relation.sourceId = hub.id;
    if (relation.targetId === 'agent-main') relation.targetId = hub.id;
  }

  for (const station of stations) {
    const hub = station.entityIds.map((id) => state.entities.get(id)).find((entity) => entity?.eventRole === 'agent-start' && entity.metadata.agentId === 'agent-main');
    const end = station.entityIds.map((id) => state.entities.get(id)).find((entity) => entity?.eventRole === 'agent-end' && entity.metadata.agentId === 'agent-main');
    const finalResponse = station.responseEntityIds.at(-1);
    // The station rail already communicates chronology. The strong flow edge
    // connects only structural milestones, avoiding a fan through every prose
    // update while preserving all message markers for direct inspection.
    const processIds = [...station.toolEntityIds, ...(finalResponse ? [finalResponse] : [])]
      .sort((leftId, rightId) => (state.entities.get(leftId)?.firstSeq ?? 0) - (state.entities.get(rightId)?.firstSeq ?? 0));
    const ordered = [
      ...station.userEntityIds,
      ...(hub ? [hub.id] : []),
      ...processIds,
      ...(end ? [end.id] : []),
    ].filter((id, index, values) => values.indexOf(id) === index);
    for (let index = 1; index < ordered.length; index += 1) {
      const source = state.entities.get(ordered[index - 1]);
      const target = state.entities.get(ordered[index]);
      if (!source || !target) continue;
      state.relations.set(`flow:${station.id}:${index}`, {
        id: `flow:${station.id}:${index}`,
        kind: 'flow',
        sourceId: source.id,
        targetId: target.id,
        startSeq: target.firstSeq,
        endSeq: target.lastSeq,
        state: target.state === 'error' ? 'error' : 'completed',
      });
    }
  }
}

export function semanticXAtSeq(state: SpatialSceneState, seq: number): number {
  return xForSeq(state, seq);
}
