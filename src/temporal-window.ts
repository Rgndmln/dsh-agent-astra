import type { SpatialCheckpoint } from './types';

export const PAST_WINDOW_CHECKPOINTS = 18;
export const FUTURE_WINDOW_CHECKPOINTS = 6;
/** Replies are the user-facing result of a run, so they remain available for
 * considerably longer than the operational event window. */
export const ASSISTANT_REPLY_LINGER_CHECKPOINTS = 44;
export const ASSISTANT_REPLY_FULL_CHECKPOINTS = 9;
export const ASSISTANT_REPLY_MAX_PAST_DEPTH = 13;

export interface TemporalWindow {
  startIndex: number;
  endIndex: number;
  startSeq: number;
  endSeq: number;
}

export function temporalWindowAt(
  checkpoints: readonly SpatialCheckpoint[],
  cursorIndex: number,
  past = PAST_WINDOW_CHECKPOINTS,
  future = FUTURE_WINDOW_CHECKPOINTS,
): TemporalWindow {
  if (!checkpoints.length) return { startIndex: 0, endIndex: 0, startSeq: 0, endSeq: 0 };
  const safeCursor = Math.max(0, Math.min(checkpoints.length - 1, cursorIndex));
  const startIndex = Math.max(0, safeCursor - past);
  const endIndex = Math.min(checkpoints.length - 1, safeCursor + future);
  return {
    startIndex,
    endIndex,
    startSeq: checkpoints[startIndex].seq,
    endSeq: checkpoints[endIndex].seq,
  };
}

export function checkpointIndexAtOrBefore(checkpoints: readonly SpatialCheckpoint[], seq: number): number {
  if (!checkpoints.length) return 0;
  let low = 0;
  let high = checkpoints.length - 1;
  let result = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (checkpoints[middle].seq <= seq) {
      result = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return result;
}

/** Whether a completed reply remains in the extended dialogue retention lane. */
export function isAssistantReplyLingering(
  checkpoints: readonly SpatialCheckpoint[],
  cursorIndex: number,
  replySeq: number,
): boolean {
  if (!checkpoints.length) return false;
  const safeCursor = Math.max(0, Math.min(checkpoints.length - 1, cursorIndex));
  const replyIndex = checkpointIndexAtOrBefore(checkpoints, replySeq);
  return replyIndex >= Math.max(0, safeCursor - ASSISTANT_REPLY_LINGER_CHECKPOINTS);
}

/** Slow a past reply's drift through semantic time without freezing it in place. */
export function assistantReplyTemporalDistance(distance: number): number {
  if (distance >= 0) return distance;
  return Math.max(-ASSISTANT_REPLY_MAX_PAST_DEPTH, Math.ceil(distance * 0.42));
}

export function adjacentMessageIndex(
  checkpoints: readonly SpatialCheckpoint[],
  cursorIndex: number,
  direction: 'previous' | 'next',
): number {
  const step = direction === 'previous' ? -1 : 1;
  for (let index = cursorIndex + step; index >= 0 && index < checkpoints.length; index += step) {
    if (checkpoints[index].kind === 'prompt' || checkpoints[index].kind === 'agent') return index;
  }
  return Math.max(0, Math.min(checkpoints.length - 1, cursorIndex));
}
