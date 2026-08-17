import type { HarnessEvent } from './types';

const base = Date.UTC(2026, 7, 16, 12, 20, 0);
const e = (seq: number, type: string, data: Record<string, unknown>, gap = seq * 1800): HarnessEvent => ({
  sessionId: 'session-spatial-demo',
  seq,
  timestamp: base + gap,
  type,
  data,
});

export const demoEvents: HarnessEvent[] = [
  e(1, 'user/message', { content: '检查 renderer pipeline，并找出最值得修复的一处问题。' }),
  e(2, 'turn/start', { turn: 1, model: 'DeepSeek Flash' }),
  e(3, 'step/start', { step: 1 }),
  e(4, 'tool/call', { callId: 'call-read', toolName: 'read_file', input: { path: 'src/renderer.ts' } }),
  e(5, 'tool/result', { callId: 'call-read', toolName: 'read_file', status: 'success', output: 'Renderer initializes the scene and animation loop.' }),
  e(6, 'assistant/message', { content: '我先检查 renderer 的生命周期和事件清理。' }),
  e(7, 'tool/call', { callId: 'call-search', toolName: 'search', input: { query: 'dispose renderer event listener' } }),
  e(8, 'tool/result', { callId: 'call-search', toolName: 'search', status: 'success', output: 'Found 3 likely lifecycle sites.', externalUrl: 'https://github.com/example/renderer' }),
  e(9, 'subagent/start', { agentId: 'agent-child-1', parentAgentId: 'agent-main', task: '复核 renderer 的 cleanup 路径', model: 'DeepSeek Flash' }),
  e(10, 'tool/call', { agentId: 'agent-child-1', callId: 'call-child-read', toolName: 'read_file', input: { path: 'src/renderer.ts' } }),
  e(11, 'tool/result', { agentId: 'agent-child-1', callId: 'call-child-read', toolName: 'read_file', status: 'success', output: 'ResizeObserver is created but not disconnected.' }),
  e(12, 'assistant/message', { agentId: 'agent-child-1', content: '确认 ResizeObserver 在卸载路径中缺少 disconnect。' }),
  e(13, 'subagent/end', { agentId: 'agent-child-1', parentAgentId: 'agent-main', status: 'success', result: 'ResizeObserver should be disconnected in dispose().' }),
  e(14, 'tool/call', { callId: 'call-edit', toolName: 'edit_file', input: { path: 'src/renderer.ts' }, fileBefore: 'old', fileAfter: 'new', added: 4, removed: 1 }),
  e(15, 'file/snapshot', { path: 'src/renderer.ts', exact: true, content: 'export function dispose(){ observer.disconnect(); }', added: 4, removed: 1 }),
  e(16, 'tool/result', { callId: 'call-edit', toolName: 'edit_file', status: 'success', output: 'Updated src/renderer.ts.' }),
  e(17, 'tool/call', { callId: 'call-test', toolName: 'test', input: { command: 'npm test -- renderer' } }),
  e(18, 'tool/result', { callId: 'call-test', toolName: 'test', status: 'success', output: '18 tests passed.' }),
  e(19, 'assistant/message', { content: '已修复清理路径，并用测试确认没有遗留观察器。', responsePreview: '已修复清理路径，并用测试确认没有遗留观察器。' }),
  e(20, 'step/end', { step: 1, status: 'success' }),
  e(21, 'turn/end', { turn: 1, status: 'success' }),
];
