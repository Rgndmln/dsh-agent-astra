import { describe, expect, it } from 'vitest';
import { demoEvents } from './fixture';
import { MAX_TIMELINE_CHECKPOINTS, MAX_TRAIL_POINTS, activityAtCursor, entitiesAtCursor, latestActivityForEntity, normalizeEvent, projectEvents, sourceEventsForActivity } from './projection';

describe('spatial projection', () => {
  it('keeps token chunks out of semantic checkpoints', () => {
    expect(normalizeEvent({ ...demoEvents[0], type: 'assistant/chunk', data: { delta: 'x' } }).kind).toBe('agent');
    const state = projectEvents([...demoEvents, { ...demoEvents[0], seq: 22, type: 'assistant/chunk', data: { delta: 'noise' } }]);
    expect(state.checkpoints.some((checkpoint) => checkpoint.seq === 22)).toBe(false);
  });

  it('merges common assistant delta variants into the live bubble', () => {
    const state = projectEvents([
      { sessionId: 'session', seq: 1, type: 'turn/start', data: {} },
      { sessionId: 'session', seq: 2, type: 'assistant/delta', data: { delta: '正在分析' } },
      { sessionId: 'session', seq: 3, type: 'message/delta', data: { role: 'assistant', delta: { content: '文件。' } } },
      { sessionId: 'session', seq: 4, type: 'assistant/message', data: { content: '正在分析文件。' } },
      { sessionId: 'session', seq: 5, type: 'turn/end', data: { status: 'success' } },
    ]);
    const bubble = [...state.entities.values()].find((entity) => entity.eventRole === 'assistant-message');
    expect(bubble?.message).toBe('正在分析文件。');
    expect(entitiesAtCursor(state, 2).find((entity) => entity.id === bubble?.id)?.message).toBe('正在分析');
    expect(bubble?.messageHistory?.at(-1)).toMatchObject({ seq: 4, content: '正在分析文件。' });
    expect(state.checkpoints.some((checkpoint) => checkpoint.seq === 2 || checkpoint.seq === 3)).toBe(false);
  });

  it('keeps one cursor-readable activity for a streaming reply without retaining every token sequence', () => {
    const state = projectEvents([
      { sessionId: 'session', seq: 1, type: 'turn/start', data: { turn: 1 } },
      { sessionId: 'session', seq: 2, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '正在' } } },
      { sessionId: 'session', seq: 3, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '分析文件' } } },
      { sessionId: 'session', seq: 4, type: 'assistant/message', data: { turn: 1, step: 1, content: '正在分析文件。' } },
    ]);
    const live = activityAtCursor(state, 3);
    expect(live).toMatchObject({ kind: 'agent', state: 'running', summary: 'Streaming response', sourceSeqs: [2] });
    const final = activityAtCursor(state, 4);
    expect(final).toMatchObject({ kind: 'agent', state: 'waiting', summary: '正在分析文件。', sourceSeqs: [2, 4] });
  });

  it('does not turn unknown Harness internals into timeline checkpoints', () => {
    const state = projectEvents([{ sessionId: 'session', seq: 1, type: 'runtime/heartbeat', data: { tick: 1 } }]);
    expect(state.events).toHaveLength(1);
    expect(state.checkpoints).toHaveLength(0);
  });

  it('merges a tool call and its result into one navigable lifecycle', () => {
    const state = projectEvents([
      { sessionId: 'session', seq: 1, timestamp: 1_000, type: 'tool/call', data: { callId: 'read-1', toolName: 'read_file' } },
      { sessionId: 'session', seq: 2, timestamp: 1_500, type: 'tool/result', data: { callId: 'read-1', toolName: 'read_file', status: 'success', output: 'done' } },
    ]);
    expect(state.events).toHaveLength(2);
    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints[0]).toMatchObject({ seq: 2, state: 'completed', toolCalls: ['read-1'] });
  });

  it('recovers nested Harness tool results as one causal activity without duplicating their payload', () => {
    const events = [
      {
        sessionId: 'session', seq: 11, type: 'tool/call', data: {
          callId: 'call-nested', name: 'read', arguments: '{"file_path":"src/app.ts"}',
        },
      },
      {
        sessionId: 'session', seq: 12, type: 'tool/result', data: {
          message: {
            source: { kind: 'tool', callId: 'call-nested' },
            content: [{ type: 'tool-result', toolCallId: 'call-nested', content: [{ type: 'text', text: 'export const answer = 42;' }] }],
          },
        },
      },
    ];
    const normalized = normalizeEvent(events[1]);
    expect(normalized).toMatchObject({ kind: 'tool', callId: 'call-nested', outcomePreview: 'export const answer = 42;', state: 'completed' });

    const state = projectEvents(events);
    const activity = state.activities.get('activity:tool:call-nested');
    expect(activity).toMatchObject({
      action: 'read', filePath: 'src/app.ts', toolName: 'read', state: 'completed',
      sourceSeqs: [11, 12], outcomePreview: 'export const answer = 42;',
    });
    expect(activity?.entityIds).toEqual(expect.arrayContaining(['agent-main', 'tool:call-nested', 'file:src/app.ts']));
    expect(sourceEventsForActivity(state, activity!)).toEqual(events);
    expect(state.checkpoints[0]).toMatchObject({ activityId: 'activity:tool:call-nested', sourceSeqs: [11, 12] });
    expect(latestActivityForEntity(state, 'file:src/app.ts', 11)?.state).toBe('running');
    expect(latestActivityForEntity(state, 'file:src/app.ts', 12)?.outcomePreview).toBe('export const answer = 42;');
  });

  it('caps timeline navigation while retaining the complete raw event history', () => {
    const events = Array.from({ length: MAX_TIMELINE_CHECKPOINTS + 250 }, (_, index) => ({
      sessionId: 'session',
      seq: index + 1,
      timestamp: index * 2_000,
      type: 'tool/result',
      data: { callId: `call-${index}`, toolName: 'read_file', status: 'success' },
    }));
    const state = projectEvents(events);
    expect(state.events).toHaveLength(events.length);
    expect(state.checkpoints).toHaveLength(MAX_TIMELINE_CHECKPOINTS);
    expect(state.checkpoints[0]?.seq).toBe(1);
    expect(state.checkpoints.at(-1)?.seq).toBe(events.length);
  });

  it('keeps render trails bounded for dense raw event streams', () => {
    const events = Array.from({ length: MAX_TRAIL_POINTS * 3 }, (_, index) => ({
      sessionId: 'session',
      seq: index + 1,
      type: 'runtime/heartbeat',
      data: { tick: index },
    }));
    const state = projectEvents(events);
    expect(state.entities.get('agent-main')?.trail.length).toBeLessThanOrEqual(MAX_TRAIL_POINTS + 1);
  });

  it('creates one file lifeline and one delegation relation', () => {
    const state = projectEvents(demoEvents);
    const snapshots = state.entities.get('file:src/renderer.ts')?.snapshots;
    expect(snapshots).toHaveLength(1);
    expect(snapshots?.[0]).toMatchObject({ exact: true, content: expect.any(String) });
    expect(state.relations.get('delegate:agent-main:agent-child-1')?.state).toBe('completed');
  });

  it('projects agent boundaries and replay-safe user and assistant bubbles', () => {
    const state = projectEvents(demoEvents);
    const roles = [...state.entities.values()].filter((entity) => entity.kind === 'event').map((entity) => entity.eventRole);
    expect(roles.filter((role) => role === 'agent-start')).toHaveLength(2);
    expect(roles.filter((role) => role === 'agent-end')).toHaveLength(2);
    expect(roles).toContain('user-message');
    expect(roles.filter((role) => role === 'assistant-message')).toHaveLength(3);

    const mainBubbles = [...state.entities.values()]
      .filter((entity) => entity.eventRole === 'assistant-message' && entity.metadata.agentId === 'agent-main')
      .sort((left, right) => left.firstSeq - right.firstSeq);
    expect(mainBubbles).toHaveLength(2);
    expect(entitiesAtCursor(state, 2).some((entity) => entity.id === mainBubbles[0]?.id)).toBe(false);
    expect(entitiesAtCursor(state, 6).find((entity) => entity.id === mainBubbles[0]?.id)?.message).toContain('检查 renderer');
    expect(entitiesAtCursor(state, 19).find((entity) => entity.id === mainBubbles[1]?.id)?.message).toContain('已修复清理路径');
  });

  it('projects only the text that Harness Chat shows on screen', () => {
    const state = projectEvents([
      {
        sessionId: 'session', seq: 1, type: 'user/message',
        data: { id: 'user-1', role: 'user', source: { kind: 'user' }, surfaceOp: 'append', content: [{ type: 'text', text: '请检查这个项目' }] },
      },
      { sessionId: 'session', seq: 2, type: 'turn/start', data: { turn: 1 } },
      { sessionId: 'session', seq: 3, type: 'step/start', data: { turn: 1, step: 1 } },
      { sessionId: 'session', seq: 4, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '内部推理' } } },
      { sessionId: 'session', seq: 5, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: '这是屏幕上' } } },
      { sessionId: 'session', seq: 6, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'read_file', argumentsDelta: '{"path":"secret.ts"}' } } },
      {
        sessionId: 'session', seq: 7, type: 'assistant/message',
        data: {
          turn: 1, step: 1, surfaceOp: 'append',
          message: {
            id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'flash' },
            content: [
              { type: 'reasoning', text: '内部推理' },
              { type: 'text', text: '这是屏幕上真正显示的回复。' },
              { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"secret.ts"}' },
            ],
          },
        },
      },
      {
        sessionId: 'session', seq: 8, type: 'user/message',
        data: { id: 'context-1', role: 'user', source: { kind: 'plugin', plugin: 'runtime-context' }, surfaceOp: 'append', content: [{ type: 'text', text: '<system-reminder>内部上下文</system-reminder>' }] },
      },
    ]);
    const bubbles = [...state.entities.values()].filter((entity) => entity.eventRole === 'user-message' || entity.eventRole === 'assistant-message');
    expect(bubbles).toHaveLength(2);
    expect(bubbles.find((entity) => entity.eventRole === 'user-message')?.message).toBe('请检查这个项目');
    const assistant = bubbles.find((entity) => entity.eventRole === 'assistant-message');
    expect(assistant?.message).toBe('这是屏幕上真正显示的回复。');
    expect(assistant?.message).not.toContain('内部推理');
    expect(assistant?.message).not.toContain('secret.ts');
    expect(assistant?.position[2]).toBeGreaterThan(entitiesAtCursor(state, 5).find((entity) => entity.id === assistant?.id)!.position[2]);
  });

  it('keeps human prompts from generic message streams as visible station anchors', () => {
    const state = projectEvents([
      {
        sessionId: 'session', seq: 1, type: 'message/append',
        data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '# 请检查 **Markdown** 回复' }] },
      },
      { sessionId: 'session', seq: 2, type: 'turn/start', data: { turn: 1 } },
      { sessionId: 'session', seq: 3, type: 'assistant/message', data: { turn: 1, step: 1, content: '收到。' } },
    ]);

    const prompt = [...state.entities.values()].find((entity) => entity.eventRole === 'user-message');
    expect(prompt).toMatchObject({ message: '# 请检查 **Markdown** 回复', position: [-7.4, 1.2, expect.any(Number)] });
    expect(state.stations[0]?.userEntityIds).toContain(prompt?.id);
  });

  it('keeps modified files and a useful minimum set of read files as visible landmarks', () => {
    const state = projectEvents([
      { sessionId: 'session', seq: 1, type: 'tool/call', data: { callId: 'read-a', toolName: 'read_file', input: { path: 'src/incidental.ts' } } },
      { sessionId: 'session', seq: 2, type: 'tool/call', data: { callId: 'write-b', toolName: 'edit_file', input: { path: 'src/core.ts' } } },
      { sessionId: 'session', seq: 3, type: 'tool/call', data: { callId: 'read-c', toolName: 'read', input: '{"file_path":"README.md"}' } },
    ]);
    expect(state.entities.get('file:src/core.ts')?.metadata.landmark).toBe('true');
    expect(state.entities.get('file:src/incidental.ts')?.metadata.landmark).toBe('true');
    expect(entitiesAtCursor(state, 2).some((entity) => entity.id === 'file:src/core.ts')).toBe(true);
    expect(entitiesAtCursor(state, 2).some((entity) => entity.id === 'file:src/incidental.ts')).toBe(true);
    expect(entitiesAtCursor(state, 3).some((entity) => entity.id === 'file:README.md')).toBe(true);
  });

  it('lays out turns as separated semantic stations instead of raw-seq compression', () => {
    const events = [
      { sessionId: 'session', seq: 1, type: 'turn/start', data: { turn: 1 } },
      { sessionId: 'session', seq: 2, type: 'user/message', data: { content: '第一轮' } },
      ...Array.from({ length: 250 }, (_, index) => ({ sessionId: 'session', seq: index + 3, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'usage' } } })),
      { sessionId: 'session', seq: 253, type: 'assistant/message', data: { turn: 1, step: 1, content: '第一轮回复' } },
      { sessionId: 'session', seq: 254, type: 'turn/end', data: { turn: 1 } },
      { sessionId: 'session', seq: 255, type: 'turn/start', data: { turn: 2 } },
      { sessionId: 'session', seq: 256, type: 'user/message', data: { content: '第二轮' } },
      { sessionId: 'session', seq: 257, type: 'assistant/message', data: { turn: 2, step: 1, content: '第二轮回复' } },
      { sessionId: 'session', seq: 258, type: 'turn/end', data: { turn: 2 } },
    ];
    const state = projectEvents(events);
    expect(state.stations).toHaveLength(2);
    expect(state.stations[1].startX - state.stations[0].endX).toBeGreaterThanOrEqual(7);
    expect(state.stations[0].endX - state.stations[0].startX).toBeLessThanOrEqual(46);
    expect([...state.relations.values()].some((relation) => relation.kind === 'flow')).toBe(true);
  });

  it('keeps tool calls as individual execution-chain nodes', () => {
    const state = projectEvents([
      { sessionId: 'session', seq: 1, type: 'turn/start', data: { turn: 1 } },
      { sessionId: 'session', seq: 2, type: 'tool/call', data: { callId: 'a', toolName: 'read_file', input: { path: 'a.ts' } } },
      { sessionId: 'session', seq: 3, type: 'tool/result', data: { callId: 'a', status: 'success' } },
      { sessionId: 'session', seq: 4, type: 'tool/call', data: { callId: 'b', toolName: 'read_file', input: { path: 'b.ts' } } },
      { sessionId: 'session', seq: 5, type: 'tool/result', data: { callId: 'b', status: 'success' } },
      { sessionId: 'session', seq: 6, type: 'turn/end', data: { turn: 1 } },
    ]);
    const tools = [...state.entities.values()].filter((entity) => entity.kind === 'tool');
    const files = [...state.entities.values()].filter((entity) => entity.kind === 'file');
    expect(tools.map((tool) => tool.id)).toEqual(['tool:a', 'tool:b']);
    expect(new Set(tools.map((tool) => tool.position[1])).size).toBeGreaterThan(1);
    expect(tools[0].position[2]).toBeLessThan(tools[1].position[2]);
    expect(files.every((file) => file.position[1] > 0)).toBe(true);
    expect(new Set(files.map((file) => file.position[0])).size).toBeGreaterThan(1);
  });

  it('is deterministic for replay and incremental append', () => {
    const full = projectEvents(demoEvents);
    const first = projectEvents(demoEvents.slice(0, 10));
    const incremental = projectEvents(demoEvents.slice(10), first);
    expect([...incremental.entities.keys()]).toEqual([...full.entities.keys()]);
    expect([...incremental.relations.keys()]).toEqual([...full.relations.keys()]);
    expect(incremental.checkpoints.map((item) => item.seq)).toEqual(full.checkpoints.map((item) => item.seq));
  });
});
