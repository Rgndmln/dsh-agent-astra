import { describe, expect, it } from 'vitest';
import {
  assistantReplyTemporalDistance,
  adjacentMessageIndex,
  isAssistantReplyLingering,
  temporalWindowAt,
} from './temporal-window';
import type { SpatialCheckpoint } from './types';

const checkpoint = (seq: number, kind: SpatialCheckpoint['kind']): SpatialCheckpoint => ({
  id: `checkpoint:${seq}`,
  seq,
  agentId: 'agent-main',
  kind,
  title: kind,
  summary: kind,
  eventType: kind,
  toolCalls: [],
});

describe('temporal window navigation', () => {
  const checkpoints = [
    checkpoint(10, 'prompt'),
    checkpoint(20, 'tool'),
    checkpoint(30, 'agent'),
    checkpoint(40, 'tool'),
    checkpoint(50, 'agent'),
    checkpoint(60, 'checkpoint'),
  ];

  it('keeps a bounded past and future around the cursor', () => {
    expect(temporalWindowAt(checkpoints, 3, 2, 1)).toEqual({ startIndex: 1, endIndex: 4, startSeq: 20, endSeq: 50 });
    expect(temporalWindowAt(checkpoints, 0, 2, 1)).toMatchObject({ startIndex: 0, endIndex: 1 });
  });

  it('uses Shift navigation to jump between transcript messages', () => {
    expect(adjacentMessageIndex(checkpoints, 5, 'previous')).toBe(4);
    expect(adjacentMessageIndex(checkpoints, 4, 'previous')).toBe(2);
    expect(adjacentMessageIndex(checkpoints, 1, 'next')).toBe(2);
  });

  it('keeps replies readable after ordinary operational events have left the window', () => {
    const longTimeline = Array.from({ length: 54 }, (_, index) => checkpoint((index + 1) * 10, index % 3 === 0 ? 'agent' : 'tool'));
    expect(isAssistantReplyLingering(longTimeline, 50, 100)).toBe(true);
    expect(isAssistantReplyLingering(longTimeline, 50, 10)).toBe(false);
    expect(assistantReplyTemporalDistance(-8)).toBe(-3);
    expect(assistantReplyTemporalDistance(-80)).toBe(-13);
  });
});
