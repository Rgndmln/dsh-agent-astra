import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { demoEvents } from './fixture';
import { activityAtCursor, entitiesAtCursor, latestActivityForEntity, projectEvents } from './projection';
import { semanticXAtSeq } from './station-layout';
import { SpatialRenderer } from './spatial-renderer';
import {
  adjacentMessageIndex,
  ASSISTANT_REPLY_FULL_CHECKPOINTS,
  assistantReplyTemporalDistance,
  checkpointIndexAtOrBefore,
  isAssistantReplyLingering,
  temporalWindowAt,
} from './temporal-window';
import type { EntityKind, FileSnapshot, HarnessEvent, SpatialActivity, SpatialCheckpoint, SpatialEntity, SpatialSceneState } from './types';

type Theme = 'dark' | 'light';
type Language = 'zh' | 'en';

const copy = {
  zh: {
    view: '空间轨迹', run: '当前运行', live: '实时', paused: '已暂停', follow: '回到实时', pause: '暂停时间线', resume: '继续时间线', checkpoints: '检查点',
    switchToLight: '切换为浅色空间', switchToDark: '切换为深色空间', motionOff: '降低动态效果', motionOn: '恢复动态效果',
    help: '使用说明', close: '关闭', history: '加载更早记录', loading: '正在加载早期轨迹…',
    past: '过去', present: '现在', future: '未来', window: '窗口', time: '语义时间 / Z', runtime: '信息层级 / Y', branch: '因果通道 / X',
    canvasHint: '拖动旋转 · 滚轮缩放 · 单击选择 · 双击聚焦 · ↑/↓ 穿行时间', select: '选择一个空间实体', waiting: '等待 Agent 活动',
    waitingDetail: 'Harness 的实时事件抵达后，轨迹会在这里生长。', inspector: '实体详情', status: '状态', sequence: '序列', model: '模型',
    task: '任务', path: '路径', resource: '资源', activity: '最近活动', snapshots: '文件快照', noSnapshot: '尚未记录文件快照。', markdownPreview: 'Markdown 预览', messageContent: '消息内容', fullPath: '完整路径', dragPanel: '拖动以移动信息框',
    exact: '精确快照', derived: '仅元数据', latest: '当前文件', historySnapshot: '历史快照', push: '推入聊天框 · 可拖拽', addToDraft: '加入草稿 · 可拖拽',
    drag: '拖到下方原生聊天框', dragLocal: '拖到下方验证聊天框', unavailable: '该历史内容不在当前事件窗口中，不能伪造附件。', snapshotTooLarge: '该精确快照过大，请从轨迹查看详情。',
    addedToNative: '已写入 Harness 原生聊天草稿。', addedToDraft: '已添加到本地草稿。', restoreUnavailable: '恢复功能需要安全的 Host capability。',
    standaloneLabel: '本地验证聊天框', standaloneHint: '拖动文件标签到这里，或继续输入问题。', composerPlaceholder: '继续向 Agent 提问…', send: '发送',
    guideTitle: '如何穿行时间走廊', guideText: 'Z 轴是语义时间：时间门标记现在，过去向后退远，未来只显示轮廓。X 轴分开用户、主 Agent、工具、回复和子 Agent；Y 轴将文件记忆抬到上层。',
    guideControl: '窗口只展示当前点前后的有限活动。↑/↓ 逐事件移动，Shift+↑/↓ 跳到相邻屏幕消息；节点会进入、突出并离开窗口，相机保留你的旋转和缩放。', noActivity: '尚无可显示的语义活动', reference: '已附加内容会以实际文本进入草稿，不会制造无法解析的装饰附件。',
    keyboardTimeline: '↑/↓ 逐事件 · Shift 跳消息', currentEvent: '当前事件',
    state: { running: '运行中', waiting: '等待中', completed: '已完成', error: '异常', observed: '已观察' },
    kind: { agent: '主 Agent', subagent: '子 Agent', file: '文件', tool: '工具', external: '外部资源', event: '轨迹事件', unknown: '事件' },
    event: { prompt: '用户输入', agent: 'Agent 响应', checkpoint: '检查点', file: '文件活动', tool: '工具调用', subagent: '子 Agent', external: '外部资源', unknown: '未知事件' },
  },
  en: {
    view: 'Spatial trajectory', run: 'Current run', live: 'Live', paused: 'Paused', follow: 'Return to live', pause: 'Pause timeline', resume: 'Resume timeline', checkpoints: 'points',
    switchToLight: 'Use light space', switchToDark: 'Use dark space', motionOff: 'Reduce motion', motionOn: 'Restore motion',
    help: 'How to use', close: 'Close', history: 'Load earlier activity', loading: 'Loading earlier trajectory…',
    past: 'Past', present: 'Present', future: 'Future', window: 'Window', time: 'Semantic time / Z', runtime: 'Information layer / Y', branch: 'Causal lanes / X',
    canvasHint: 'Drag to orbit · scroll to zoom · click to select · double-click to focus · ↑/↓ travel in time', select: 'Select an entity in space', waiting: 'Waiting for agent activity',
    waitingDetail: 'The trajectory will grow here as live Harness events arrive.', inspector: 'Entity details', status: 'Status', sequence: 'Sequence', model: 'Model',
    task: 'Task', path: 'Path', resource: 'Resource', activity: 'Latest activity', snapshots: 'File snapshots', noSnapshot: 'No file snapshot recorded.', markdownPreview: 'Markdown preview', messageContent: 'Message', fullPath: 'Full path', dragPanel: 'Drag to move this panel',
    exact: 'Exact snapshot', derived: 'Metadata only', latest: 'Current file', historySnapshot: 'Historical snapshot', push: 'Push to composer · drag', addToDraft: 'Add to draft · drag',
    drag: 'Drag to the native composer below', dragLocal: 'Drag to the verification composer below', unavailable: 'This historical content is not in the current event window, so no attachment is fabricated.', snapshotTooLarge: 'This exact snapshot is too large; inspect it from the trajectory instead.',
    addedToNative: 'Added to the native Harness composer draft.', addedToDraft: 'Added to the local draft.', restoreUnavailable: 'Restore needs a safe host capability.',
    standaloneLabel: 'Local verification composer', standaloneHint: 'Drop a file chip here or continue the conversation.', composerPlaceholder: 'Continue the conversation…', send: 'Send',
    guideTitle: 'How to travel the time corridor', guideText: 'Z is semantic time: the portal marks now, the past recedes, and the future is only a silhouette. X separates causal lanes; Y lifts persistent file memory above execution.',
    guideControl: 'Only a bounded window around the cursor is rendered. ↑/↓ moves event by event; Shift+↑/↓ jumps between transcript messages. Nodes enter, focus, and leave while your orbit and zoom are preserved.', noActivity: 'No semantic activity to display yet', reference: 'Attached content is inserted as real draft text, never as an unresolved decorative chip.',
    keyboardTimeline: '↑/↓ event · Shift jumps messages', currentEvent: 'Current event',
    state: { running: 'Running', waiting: 'Waiting', completed: 'Completed', error: 'Error', observed: 'Observed' },
    kind: { agent: 'Main Agent', subagent: 'Subagent', file: 'File', tool: 'Tool', external: 'External resource', event: 'Trajectory event', unknown: 'Event' },
    event: { prompt: 'User prompt', agent: 'Agent response', checkpoint: 'Checkpoint', file: 'File activity', tool: 'Tool call', subagent: 'Subagent', external: 'External resource', unknown: 'Unknown event' },
  },
} as const;

type Copy = typeof copy[Language];

const glyphs: Record<EntityKind, string> = { agent: '◇', subagent: '◈', file: '▱', tool: '⬡', external: '○', event: '◆', unknown: '△' };
const colors: Record<EntityKind, string> = { agent: '#859fff', subagent: '#56c9a9', file: '#b49bea', tool: '#e9ad60', external: '#db8fb2', event: '#9fb4ff', unknown: '#8295ae' };
const maxSnapshotCharacters = 18_000;
const temporalDepthStep = 2.35;

function localizedLanguageTag(language: Language): string { return language === 'zh' ? 'zh-CN' : 'en-US'; }
function formatTime(timestamp: number | undefined, language: Language, fallback: string): string {
  return timestamp
    ? new Intl.DateTimeFormat(localizedLanguageTag(language), { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(timestamp))
    : fallback;
}
function appendDraft(draft: string, value: string): string { return `${draft}${draft.trim() ? '\n\n' : ''}${value}`; }
function snapshotPrompt(snapshot: FileSnapshot, language: Language, fallback: string): string | undefined {
  if (!snapshot.exact || !snapshot.content) return undefined;
  const label = language === 'zh' ? '精确历史文件快照' : 'Exact historical file snapshot';
  return `[${label}: ${snapshot.path} · ${formatTime(snapshot.timestamp, language, fallback)}]\n\`\`\`\n${snapshot.content}\n\`\`\``;
}
function isEditableTarget(target: EventTarget | null): boolean {
  // The timeline is a range input. It must retain the global ↑/↓ navigation
  // semantics after the user has clicked or scrubbed it, unlike text fields.
  if (target instanceof HTMLInputElement && target.type === 'range') return false;
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}
function localizedEntityLabel(entity: SpatialEntity, language: Language): string {
  if (entity.eventRole === 'agent-start') return language === 'zh' ? 'Agent 开始' : 'Agent started';
  if (entity.eventRole === 'agent-end') return language === 'zh' ? 'Agent 结束' : 'Agent completed';
  if (entity.eventRole === 'user-message') return language === 'zh' ? '用户消息' : 'User message';
  if (entity.eventRole === 'assistant-message') return language === 'zh' ? 'Agent 回复' : 'Agent response';
  return entity.label;
}

function fileName(path: string | undefined, fallback: string): string {
  const parts = path?.split(/[\\/]/).filter(Boolean) ?? [];
  return parts.at(-1) ?? fallback;
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join('/')}`;
}

type ActivityNarrative = { label: string; headline: string; detail?: string; state: 'running' | 'waiting' | 'completed' | 'error' };

function shortActivityText(value: string, max = 88): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }

function activityNarrative(activity: SpatialActivity | undefined, language: Language): ActivityNarrative {
  const running = activity?.state === 'running';
  const failed = activity?.state === 'error';
  const completed = activity?.state === 'completed';
  const state = failed ? 'error' : running ? 'running' : completed ? 'completed' : 'waiting';
  if (!activity) return language === 'zh'
    ? { label: '此刻', headline: '等待下一步指令', state }
    : { label: 'Now', headline: 'Waiting for the next instruction', state };
  const file = activity.filePath ? fileName(activity.filePath, activity.title) : undefined;
  const target = file ?? activity.toolName ?? activity.title;
  const verb = (active: string, done: string, error: string) => failed ? error : running ? active : done;
  const headline = language === 'zh'
    ? (() => {
      switch (activity.action) {
        case 'prompt': return '正在接收你的请求';
        case 'respond': return verb('正在组织回复', '已生成回复', '回复遇到问题');
        case 'read': return `${verb('正在读取', '已读取', '读取失败')} ${target}`;
        case 'write': return activity.toolName === 'todo_write'
          ? verb('正在更新任务清单', '已更新任务清单', '任务清单更新失败')
          : `${verb('正在修改', '已修改', '修改失败')} ${target}`;
        case 'execute': return `${verb('正在运行', '已运行', '运行失败')} ${target}`;
        case 'delegate': return `${verb('正在委派', '已完成委派', '委派失败')} ${target}`;
        case 'start': return '正在开始工作步骤';
        case 'complete': return '已完成当前工作步骤';
        default: return shortActivityText(activity.summary);
      }
    })()
    : (() => {
      switch (activity.action) {
        case 'prompt': return 'Receiving your request';
        case 'respond': return verb('Composing a response', 'Response is ready', 'Response hit an error');
        case 'read': return `${verb('Reading', 'Read', 'Could not read')} ${target}`;
        case 'write': return activity.toolName === 'todo_write'
          ? verb('Updating the task list', 'Updated the task list', 'Could not update the task list')
          : `${verb('Editing', 'Edited', 'Could not edit')} ${target}`;
        case 'execute': return `${verb('Running', 'Ran', 'Could not run')} ${target}`;
        case 'delegate': return `${verb('Delegating', 'Delegated', 'Delegation failed')} ${target}`;
        case 'start': return 'Starting a work step';
        case 'complete': return 'Finished the current work step';
        default: return shortActivityText(activity.summary);
      }
    })();
  const detail = activity.outcomePreview
    ? shortActivityText(activity.outcomePreview)
    : activity.toolName && activity.filePath ? `${activity.toolName} · ${compactPath(activity.filePath)}` : undefined;
  return { label: language === 'zh' ? '此刻' : 'Now', headline: shortActivityText(headline), detail, state };
}

function inlineMarkdown(value: string): ReactNode[] {
  const tokens = value.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g);
  return tokens.map((token, index) => {
    if (/^`[^`]+`$/.test(token)) return <code key={index}>{token.slice(1, -1)}</code>;
    if (/^(\*\*[^*]+\*\*|__[^_]+__)$/.test(token)) return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (/^(\*[^*]+\*|_[^_]+_)$/.test(token)) return <em key={index}>{token.slice(1, -1)}</em>;
    const link = token.match(/^\[([^\]]+)\]\(([^\s)]+)(?:\s+&quot;[^&]*&quot;)?\)$/);
    if (link) {
      const href = link[2];
      if (/^https?:\/\//i.test(href)) return <a key={index} href={href} target="_blank" rel="noreferrer">{link[1]}</a>;
      return <span key={index}>{link[1]}</span>;
    }
    return token;
  });
}

export function MarkdownPreview({ content }: { content: string }) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;
  const isBlockStart = (line: string) => /^(#{1,6}\s+|```|>\s?|[-*+]\s+|\d+\.\s+|---+$)/.test(line);
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) { code.push(lines[index]); index += 1; }
      if (index < lines.length) index += 1;
      blocks.push(<pre key={key++} data-language={language || undefined}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const content = inlineMarkdown(heading[2]);
      const blockKey = key++;
      if (heading[1].length === 1) blocks.push(<h1 key={blockKey}>{content}</h1>);
      else if (heading[1].length === 2) blocks.push(<h2 key={blockKey}>{content}</h2>);
      else if (heading[1].length === 3) blocks.push(<h3 key={blockKey}>{content}</h3>);
      else if (heading[1].length === 4) blocks.push(<h4 key={blockKey}>{content}</h4>);
      else if (heading[1].length === 5) blocks.push(<h5 key={blockKey}>{content}</h5>);
      else blocks.push(<h6 key={blockKey}>{content}</h6>);
      index += 1;
      continue;
    }
    if (/^---+$/.test(line.trim())) { blocks.push(<hr key={key++} />); index += 1; continue; }
    const listMatch = line.match(/^([-*+])\s+(.+)$/);
    const orderedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (listMatch || orderedMatch) {
      const ordered = Boolean(orderedMatch);
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const item = ordered ? lines[index].match(/^\d+\.\s+(.+)$/) : lines[index].match(/^[-*+]\s+(.+)$/);
        if (!item) break;
        items.push(<li key={index}>{inlineMarkdown(item[1])}</li>);
        index += 1;
      }
      blocks.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }
    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith('>')) { quote.push(lines[index].replace(/^>\s?/, '')); index += 1; }
      blocks.push(<blockquote key={key++}>{inlineMarkdown(quote.join('\n'))}</blockquote>);
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) { paragraph.push(lines[index]); index += 1; }
    blocks.push(<p key={key++}>{inlineMarkdown(paragraph.join('\n'))}</p>);
  }
  return <div className="markdown-preview">{blocks}</div>;
}

function SpatialCanvas({
  state, selectedId, onSelect, reducedMotion, theme, language, cameraNavigation, onWebGLFailure,
}: {
  state: SpatialSceneState;
  selectedId?: string;
  onSelect: (id?: string, anchor?: { x: number; y: number }) => void;
  reducedMotion: boolean;
  theme: Theme;
  language: Language;
  cameraNavigation?: { seq: number; token: number };
  onWebGLFailure: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SpatialRenderer | undefined>(undefined);
  const selectRef = useRef(onSelect);
  const failureRef = useRef(onWebGLFailure);
  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { failureRef.current = onWebGLFailure; }, [onWebGLFailure]);
  useEffect(() => {
    if (!canvasRef.current) return undefined;
    try {
      const renderer = new SpatialRenderer(canvasRef.current, { reducedMotion, theme, language, onSelect: (id, anchor) => selectRef.current(id, anchor) });
      rendererRef.current = renderer;
      renderer.setState(state);
      return () => { renderer.dispose(); rendererRef.current = undefined; };
    } catch {
      failureRef.current();
      return undefined;
    }
  }, []);
  useEffect(() => { rendererRef.current?.setState(state); }, [state]);
  useEffect(() => { rendererRef.current?.setSelectedEntity(selectedId); }, [selectedId]);
  useEffect(() => { rendererRef.current?.setReducedMotion(reducedMotion); }, [reducedMotion]);
  useEffect(() => { rendererRef.current?.setTheme(theme); }, [theme]);
  useEffect(() => { rendererRef.current?.setLanguage(language); }, [language]);
  useEffect(() => {
    if (cameraNavigation) rendererRef.current?.moveToTimelineSeq(cameraNavigation.seq, state.range.startSeq, state.range.endSeq);
  }, [cameraNavigation?.token, state.range.endSeq, state.range.startSeq]);
  return <div className="canvas-shell"><canvas ref={canvasRef} aria-label="Three.js spatial trajectory" /></div>;
}

function FloatingInspector({
  entity, state, cursorSeq, text, language, anchor, nativeComposer, onClose, onPush, onToast, onReferencePointerDown, onMove,
}: {
  entity?: SpatialEntity;
  state: SpatialSceneState;
  cursorSeq: number;
  text: Copy;
  language: Language;
  anchor: { x: number; y: number };
  nativeComposer: boolean;
  onClose: () => void;
  onPush: (value: string) => void;
  onToast: (message: string) => void;
  onReferencePointerDown: (event: ReactPointerEvent<HTMLElement>, value: string) => void;
  onMove: (position: { x: number; y: number }) => void;
}) {
  const dragCleanupRef = useRef<(() => void) | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const stopDragging = useCallback(() => {
    dragCleanupRef.current?.();
    dragCleanupRef.current = undefined;
    setDragging(false);
  }, []);
  useEffect(() => () => stopDragging(), [stopDragging]);
  const startDragging = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const stage = event.currentTarget.closest('.spatial-stage')?.getBoundingClientRect();
    if (!stage) return;
    event.preventDefault();
    const origin = { clientX: event.clientX, clientY: event.clientY, ...anchor };
    const maximumY = entity?.eventRole === 'user-message' || entity?.eventRole === 'assistant-message'
      ? 10
      : entity?.kind === 'file' ? 24 : 37;
    const move = (moveEvent: PointerEvent) => {
      const x = origin.x + ((moveEvent.clientX - origin.clientX) / stage.width) * 100;
      const y = origin.y + ((moveEvent.clientY - origin.clientY) / stage.height) * 100;
      onMove({ x: Math.round(Math.max(2, Math.min(70, x))), y: Math.round(Math.max(3, Math.min(maximumY, y))) });
    };
    const end = () => stopDragging();
    dragCleanupRef.current?.();
    dragCleanupRef.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
    window.addEventListener('pointercancel', end, { once: true });
    setDragging(true);
  }, [anchor, entity?.kind, onMove, stopDragging]);
  if (!entity) return null;
  const activity = latestActivityForEntity(state, entity.id, cursorSeq);
  const snapshot = entity.snapshots.at(-1);
  const canAttachSnapshot = Boolean(snapshot?.exact && snapshot.content && snapshot.content.length <= maxSnapshotCharacters);
  const snapshotText = snapshot ? snapshotPrompt(snapshot, language, text.sequence) : undefined;
  const currentFileText = entity.path;
  const actionLabel = nativeComposer ? text.push : text.addToDraft;
  const place = { '--inspector-x': `${anchor.x}%`, '--inspector-y': `${anchor.y}%` } as CSSProperties;
  const push = (value: string) => { onPush(value); onToast(nativeComposer ? text.addedToNative : text.addedToDraft); };
  const isFile = entity.kind === 'file';
  const isMessage = entity.eventRole === 'user-message' || entity.eventRole === 'assistant-message';
  const inspectorKind = isMessage ? localizedEntityLabel(entity, language) : text.kind[entity.kind];
  const displayPath = snapshot?.path ?? entity.path;
  const heading = isFile ? fileName(displayPath, localizedEntityLabel(entity, language)) : localizedEntityLabel(entity, language);
  return <aside className={`floating-inspector${isFile ? ' is-file' : ''}${isMessage ? ' is-message' : ''}${dragging ? ' is-dragging' : ''}`} style={place} aria-label={text.inspector}>
    <div className="inspector-topline inspector-drag-handle" onPointerDown={startDragging} title={text.dragPanel}><span className="inspector-kind" style={{ color: colors[entity.kind] }}><i>{glyphs[entity.kind]}</i>{inspectorKind}</span><span className="drag-grip" aria-hidden="true">⠿</span><button className="quiet-button" onPointerDown={(event) => event.stopPropagation()} onClick={onClose} aria-label={text.close}>×</button></div>
    <h2>{heading}</h2>
    <div className="inspector-status"><span data-state={entity.state ?? 'observed'}>{text.state[entity.state ?? 'observed']}</span><code>#{entity.firstSeq}—{entity.lastSeq}</code></div>
    {entity.task && <p className="inspector-summary">{entity.task}</p>}
    {entity.message && <section className="message-reader"><div className="markdown-reader-head"><span>{text.messageContent}</span><code>{entity.eventRole === 'user-message' ? (language === 'zh' ? '你' : 'You') : (language === 'zh' ? 'Agent' : 'Agent')}</code></div><MarkdownPreview content={entity.message} /></section>}
    {entity.model && <div className="detail-row"><span>{text.model}</span><strong>{entity.model}</strong></div>}
    {isFile && displayPath && <details className="file-path-details" aria-label={text.fullPath}><summary><span>{text.path}</span><code title={displayPath}>{compactPath(displayPath)}</code></summary><code className="full-path">{displayPath}</code></details>}
    {!isFile && entity.path && <div className="detail-row"><span>{text.path}</span><strong className="mono">{entity.path}</strong></div>}
    {entity.url && <div className="detail-row"><span>{text.resource}</span><strong className="mono">{entity.url}</strong></div>}
    {activity && !isMessage && <div className="activity-note"><span>{text.activity} · {text.state[activity.state ?? 'observed']}</span><p>{activity.summary}</p>{activity.outcomePreview && <p className="activity-outcome">{activity.outcomePreview}</p>}</div>}
    {currentFileText && <div className="composer-action">
      <button className="push-button drag-source" onPointerDown={(event) => onReferencePointerDown(event, currentFileText)} onClick={() => push(currentFileText)}>{actionLabel}</button>
      <small>{nativeComposer ? text.drag : text.dragLocal}</small>
    </div>}
    {snapshot && <div className="snapshot-action">
      <div className="snapshot-meta"><span>{text.historySnapshot}</span><strong>{formatTime(snapshot.timestamp, language, text.sequence)}</strong></div>
      <div className="snapshot-meta"><span>{snapshot.exact ? text.exact : text.derived}</span>{snapshot.change && <code>+{snapshot.change.added ?? 0} / −{snapshot.change.removed ?? 0}</code>}</div>
      {snapshot.content && <section className="markdown-reader"><div className="markdown-reader-head"><span>{text.markdownPreview}</span><code>{snapshot.content.length.toLocaleString()} B</code></div><MarkdownPreview content={snapshot.content} /></section>}
      {canAttachSnapshot && snapshotText ? <button className="push-button subtle drag-source" onPointerDown={(event) => onReferencePointerDown(event, snapshotText)} onClick={() => push(snapshotText)}>{actionLabel}</button> : <small>{snapshot.content && snapshot.content.length > maxSnapshotCharacters ? text.snapshotTooLarge : text.unavailable}</small>}
    </div>}
    <p className="inspector-footnote">{text.reference}</p>
  </aside>;
}

function SceneFallback({ text }: { text: Copy }) {
  return <div className="scene-fallback"><div>◇</div><strong>{text.select}</strong><span>{text.waitingDetail}</span></div>;
}

export interface SpatialAppProps {
  /** When present, events come from the Harness conversation view rather than the fixture replay. */
  harnessEvents?: readonly HarnessEvent[];
  harnessSessionId?: string;
  fixtureReplay?: boolean;
  onLoadOlder?: () => Promise<void>;
  nativeComposer?: boolean;
  /** Writes a real reference or exact content into Harness's session-scoped composer draft. */
  onPushToComposer?: (value: string) => void;
  initialTheme?: Theme;
  initialLanguage?: Language;
  onThemeChange?: (theme: Theme) => void;
  onLanguageChange?: (language: Language) => void;
}

function App({
  harnessEvents,
  harnessSessionId,
  fixtureReplay = true,
  onLoadOlder,
  nativeComposer = false,
  onPushToComposer,
  initialTheme = 'dark',
  initialLanguage = 'zh',
  onThemeChange,
  onLanguageChange,
}: SpatialAppProps = {}) {
  const [fixtureEvents, setFixtureEvents] = useState<HarnessEvent[]>([]);
  const [playing, setPlaying] = useState(true);
  const [cursorCheckpointIndex, setCursorCheckpointIndex] = useState(0);
  const [cameraNavigation, setCameraNavigation] = useState<{ seq: number; token: number }>();
  const [selectedId, setSelectedId] = useState<string>();
  const [inspectorAnchor, setInspectorAnchor] = useState({ x: 62, y: 18 });
  const [reducedMotion, setReducedMotion] = useState(false);
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [draft, setDraft] = useState('');
  const [toast, setToast] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const composerInputRef = useRef<HTMLInputElement>(null);
  const composerDragRef = useRef<{ value: string; x: number; y: number } | undefined>(undefined);
  const events = harnessEvents ?? fixtureEvents;
  const text = copy[language];
  const layerAxisDetail = language === 'zh' ? '执行 → 对话 → 工件' : 'execution → dialogue → artifacts';
  const causalAxisDetail = language === 'zh' ? '输入 → 主控 → 结果' : 'input → control → outcome';
  const state = useMemo(() => {
    const projected = projectEvents([...events]);
    return projected.events.length || !harnessSessionId ? projected : { ...projected, sessionId: harnessSessionId };
  }, [events, harnessSessionId]);
  const checkpointCount = state.checkpoints.length;
  const maxCheckpointIndex = Math.max(0, checkpointCount - 1);
  const cursorIndex = playing ? maxCheckpointIndex : Math.min(cursorCheckpointIndex, maxCheckpointIndex);
  const activeCheckpoint = state.checkpoints[cursorIndex];
  const cursorSeq = playing ? state.range.endSeq : activeCheckpoint?.seq ?? state.range.endSeq;
  const currentActivity = useMemo(() => activityAtCursor(state, cursorSeq), [cursorSeq, state]);
  const currentActivityNarrative = useMemo(() => activityNarrative(currentActivity, language), [currentActivity, language]);
  const timeWindow = useMemo(() => temporalWindowAt(state.checkpoints, cursorIndex), [cursorIndex, state.checkpoints]);
  const windowStartSeq = checkpointCount ? timeWindow.startSeq : state.range.startSeq;
  const windowEndSeq = checkpointCount ? timeWindow.endSeq : state.range.endSeq;
  const cursorCoordinate = semanticXAtSeq(state, cursorSeq);
  const activeStation = useMemo(() => state.stations.find((station) => station.startSeq <= cursorSeq && cursorSeq <= station.endSeq)
    ?? [...state.stations].reverse().find((station) => station.startSeq <= cursorSeq)
    ?? state.stations[0], [cursorSeq, state.stations]);
  const visibleEntities = useMemo(() => {
    const cursorSnapshots = new Map(entitiesAtCursor(state, cursorSeq).map((entity) => [entity.id, entity] as const));
    // A turn may contain tens of thousands of low-level events. Its human prompt is
    // still the causal origin of the station, so keep that prompt visible even after
    // the local time window has advanced far beyond its raw sequence number.
    const stationUserIds = new Set(state.stations
      .filter((station) => station.startSeq <= windowEndSeq && station.endSeq >= windowStartSeq)
      .flatMap((station) => station.userEntityIds));
    return [...state.entities.values()]
      .filter((entity) => entity.kind === 'agent'
        || (entity.kind === 'file' && entity.metadata.landmark !== 'false')
        || stationUserIds.has(entity.id)
        // Replies are the actual user-visible result. Keep them in the
        // dialogue layer after the operational window has moved on.
        || (entity.eventRole === 'assistant-message'
          && entity.firstSeq <= cursorSeq
          && isAssistantReplyLingering(state.checkpoints, cursorIndex, entity.lastSeq))
        || (entity.firstSeq <= windowEndSeq && entity.lastSeq >= windowStartSeq))
      .map((entity) => {
        if (entity.firstSeq <= cursorSeq) return cursorSnapshots.get(entity.id) ?? entity;
        // Future context provides direction without leaking transcript content.
        return { ...entity, message: undefined, messageHistory: undefined };
      });
  }, [cursorIndex, cursorSeq, state, windowEndSeq, windowStartSeq]);
  const recentMessageIds = useMemo(() => visibleEntities
    .filter((entity) => (entity.eventRole === 'user-message' || entity.eventRole === 'assistant-message') && entity.firstSeq <= cursorSeq && Boolean(entity.message?.trim()))
    .sort((left, right) => (left.lastSeq - right.lastSeq) || (left.firstSeq - right.firstSeq))
    .slice(-4)
    .map((entity) => entity.id), [cursorSeq, visibleEntities]);
  const latestUserMessageId = useMemo(() => visibleEntities
    .filter((entity) => entity.eventRole === 'user-message' && entity.firstSeq <= cursorSeq && Boolean(entity.message?.trim()))
    .sort((left, right) => (left.lastSeq - right.lastSeq) || (left.firstSeq - right.firstSeq))
    .at(-1)?.id, [cursorSeq, visibleEntities]);
  const latestAssistantMessageId = useMemo(() => visibleEntities
    .filter((entity) => entity.eventRole === 'assistant-message' && entity.firstSeq <= cursorSeq && Boolean(entity.message?.trim()))
    .sort((left, right) => (left.lastSeq - right.lastSeq) || (left.firstSeq - right.firstSeq))
    .at(-1)?.id, [cursorSeq, visibleEntities]);
  const lingeringFullReplyIds = useMemo(() => visibleEntities
    .filter((entity) => entity.eventRole === 'assistant-message' && entity.firstSeq <= cursorSeq && Boolean(entity.message?.trim()))
    .filter((entity) => {
      const replyIndex = checkpointIndexAtOrBefore(state.checkpoints, entity.lastSeq);
      return replyIndex >= Math.max(0, cursorIndex - ASSISTANT_REPLY_FULL_CHECKPOINTS);
    })
    .sort((left, right) => (left.lastSeq - right.lastSeq) || (left.firstSeq - right.firstSeq))
    .slice(-2)
    .map((entity) => entity.id), [cursorIndex, cursorSeq, state.checkpoints, visibleEntities]);
  /** The current semantic activity, not a nearest visual node, decides which
   * object enters the work area. This keeps the workbench causally accurate
   * while the user scrubs through a dense event stream. */
  const activeWorkEntity = useMemo(() => {
    if (!currentActivity) return undefined;
    const associated = currentActivity.entityIds
      .map((id) => visibleEntities.find((entity) => entity.id === id))
      .filter((entity): entity is SpatialEntity => Boolean(entity));
    const order: EntityKind[] = currentActivity.kind === 'tool' ? ['tool', 'file', 'external']
      : currentActivity.kind === 'file' ? ['file', 'tool']
        : currentActivity.kind === 'external' ? ['external'] : [];
    return order.map((kind) => associated.find((entity) => entity.kind === kind)).find(Boolean);
  }, [currentActivity, visibleEntities]);
  /** Explicit activity links choose the companion. The old nearest-node guess
   * made unrelated historical files appear to be part of an action. */
  const activeWorkCompanion = useMemo(() => {
    if (!activeWorkEntity || !currentActivity) return undefined;
    const expectedKind: EntityKind = activeWorkEntity.kind === 'file' ? 'tool' : 'file';
    return currentActivity.entityIds
      .map((id) => visibleEntities.find((entity) => entity.id === id))
      .find((entity): entity is SpatialEntity => entity?.kind === expectedKind);
  }, [activeWorkEntity, currentActivity, visibleEntities]);
  const agentMotionTarget = useMemo<[number, number]>(() => {
    // The Agent leans into the work area, while the operated object performs
    // the larger move. This keeps the temporal path readable as a path.
    return activeWorkEntity ? [-0.95, -0.12] : [0, -0.55];
  }, [activeWorkEntity]);
  const visibleState = useMemo<SpatialSceneState>(() => ({
    ...state,
    cursorSeq,
    stations: state.stations
      .filter((station) => station.startSeq <= windowEndSeq && station.endSeq >= windowStartSeq)
      .map((station) => {
        const startIndex = checkpointIndexAtOrBefore(state.checkpoints, Math.max(station.startSeq, windowStartSeq));
        const endIndex = checkpointIndexAtOrBefore(state.checkpoints, Math.min(station.endSeq, windowEndSeq));
        const startX = cursorCoordinate + (startIndex - cursorIndex) * temporalDepthStep;
        const endX = cursorCoordinate + (endIndex - cursorIndex) * temporalDepthStep;
        return { ...station, startX, endX, centerX: (startX + endX) / 2 };
      }),
    entities: new Map(visibleEntities.map((entity) => {
      const stationPrompt = entity.eventRole === 'user-message' && entity.metadata.stationId === activeStation?.id;
      const anchorSeq = stationPrompt
        ? cursorSeq
        : entity.firstSeq > cursorSeq ? entity.firstSeq : Math.min(entity.lastSeq, cursorSeq);
      const anchorIndex = checkpointIndexAtOrBefore(state.checkpoints, anchorSeq);
      const rawTemporalDistance = stationPrompt ? -4 : anchorIndex - cursorIndex;
      const temporalDistance = entity.eventRole === 'assistant-message'
        ? assistantReplyTemporalDistance(rawTemporalDistance)
        : rawTemporalDistance;
      const temporalPhase = stationPrompt || entity.kind === 'file'
        ? 'memory'
          : entity.firstSeq > cursorSeq ? 'future'
          : entity.firstSeq <= cursorSeq && entity.lastSeq >= cursorSeq ? 'current' : temporalDistance === 0 ? 'current' : 'past';
      const message = entity.eventRole === 'user-message' || entity.eventRole === 'assistant-message';
      let messageLod: 'full' | 'summary' | 'marker' = 'marker';
      if (message) {
        if (temporalPhase !== 'future' && (entity.id === selectedId || entity.id === latestUserMessageId || entity.id === latestAssistantMessageId || lingeringFullReplyIds.includes(entity.id))) messageLod = 'full';
        else if (temporalPhase !== 'future' && recentMessageIds.includes(entity.id)) messageLod = 'summary';
      }
      const temporalZ = cursorCoordinate + temporalDistance * temporalDepthStep;
      const position: SpatialEntity['position'] = entity.kind === 'agent' && entity.id === 'agent-main'
        ? [agentMotionTarget[0], agentMotionTarget[1], cursorCoordinate]
        // Files retain their own semantic-time homes. They enter the work area
        // only during an explicit operation instead of sliding with the cursor.
        : entity.kind === 'file' ? entity.position : [entity.position[0], entity.position[1], temporalZ];
      const workActive = entity.id === activeWorkEntity?.id;
      const workCompanion = entity.id === activeWorkCompanion?.id;
      const projected = {
        ...entity,
        position,
        trail: [],
        metadata: {
          ...entity.metadata,
          stationFocus: String(entity.metadata.stationId === activeStation?.id),
          temporalPhase,
          temporalDistance: String(temporalDistance),
          workActive: String(workActive),
          workCompanion: String(workCompanion),
          workVisual: workActive ? 'active' : entity.kind === 'tool' ? 'history' : entity.kind === 'file' ? 'resting' : 'ambient',
          replyFocus: String(entity.eventRole === 'assistant-message' && entity.id === latestAssistantMessageId),
          ...(entity.id === 'agent-main' ? {
            activityVisible: 'true',
            activityHeadline: currentActivityNarrative.headline,
            activityDetail: currentActivityNarrative.detail ?? '',
            activityState: currentActivityNarrative.state,
            activityLabel: currentActivityNarrative.label,
          } : {}),
          ...(message ? { messageLod, bubbleVisible: String(messageLod !== 'marker') } : {}),
        },
      };
      return [entity.id, projected] as const;
    })),
    relations: new Map([...state.relations.values()]
      .filter((relation) => relation.startSeq <= windowEndSeq && (relation.endSeq ?? relation.startSeq) >= windowStartSeq)
      .filter((relation) => visibleEntities.some((entity) => entity.id === relation.sourceId) && visibleEntities.some((entity) => entity.id === relation.targetId))
      .map((relation) => [relation.id, relation] as const)),
  }), [activeStation, activeWorkCompanion, activeWorkEntity, agentMotionTarget, currentActivityNarrative, cursorCoordinate, cursorIndex, cursorSeq, latestAssistantMessageId, latestUserMessageId, lingeringFullReplyIds, recentMessageIds, selectedId, state, visibleEntities, windowEndSeq, windowStartSeq]);
  const selectedEntity = visibleState.entities.get(selectedId ?? '');
  const progress = maxCheckpointIndex > 0 ? (cursorIndex / maxCheckpointIndex) * 100 : 100;
  const moveCameraToIndex = useCallback((index: number) => {
    const checkpoint = state.checkpoints[index];
    if (checkpoint) setCameraNavigation((current) => ({ seq: checkpoint.seq, token: (current?.token ?? 0) + 1 }));
  }, [state.checkpoints]);
  const moveTimeline = useCallback((direction: 'previous' | 'next', messagesOnly = false) => {
    if (!checkpointCount) return;
    const nextIndex = messagesOnly
      ? adjacentMessageIndex(state.checkpoints, cursorIndex, direction)
      : Math.max(0, Math.min(maxCheckpointIndex, cursorIndex + (direction === 'previous' ? -1 : 1)));
    setCursorCheckpointIndex(nextIndex);
    moveCameraToIndex(nextIndex);
    setPlaying(false);
  }, [checkpointCount, cursorIndex, maxCheckpointIndex, moveCameraToIndex, state.checkpoints]);
  const reportWebGLFailure = useCallback(() => setWebglFailed(true), []);

  useEffect(() => setTheme(initialTheme), [initialTheme]);
  useEffect(() => setLanguage(initialLanguage), [initialLanguage]);
  useEffect(() => {
    if (harnessEvents !== undefined || !fixtureReplay || !playing || fixtureEvents.length >= demoEvents.length) return undefined;
    const timer = window.setTimeout(() => setFixtureEvents((current) => [...current, demoEvents[current.length]]), 430);
    return () => window.clearTimeout(timer);
  }, [fixtureEvents.length, fixtureReplay, harnessEvents, playing]);
  useEffect(() => {
    if (playing && checkpointCount) setCursorCheckpointIndex(maxCheckpointIndex);
  }, [checkpointCount, maxCheckpointIndex, playing]);
  useEffect(() => {
    if (cursorCheckpointIndex > maxCheckpointIndex) setCursorCheckpointIndex(maxCheckpointIndex);
  }, [cursorCheckpointIndex, maxCheckpointIndex]);
  useEffect(() => {
    if (selectedId && !visibleEntities.some((entity) => entity.id === selectedId)) setSelectedId(undefined);
  }, [selectedId, visibleEntities]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.key === 'Escape') { setSelectedId(undefined); setGuideOpen(false); return; }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        moveTimeline(event.key === 'ArrowUp' ? 'previous' : 'next', event.shiftKey);
      }
      if (event.key === 'Home') { setCursorCheckpointIndex(0); moveCameraToIndex(0); setPlaying(false); }
      if (event.key === 'End') { setCursorCheckpointIndex(maxCheckpointIndex); moveCameraToIndex(maxCheckpointIndex); setPlaying(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maxCheckpointIndex, moveCameraToIndex, moveTimeline]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2400);
  }, []);
  const handleSelect = useCallback((id?: string, anchor?: { x: number; y: number }) => {
    setSelectedId(id);
    if (id && anchor) {
      setInspectorAnchor({
        // The details card must remain a floating companion, not conceal the selected object.
        // Canvas coordinates can be wider than the clipped host pane, so keep a generous
        // clearance on the object's left-hand side for right-half selections.
        x: anchor.x > 56 ? Math.max(3, anchor.x - 54) : Math.min(60, anchor.x + 5),
        // Keep the expanded reader above Harness's sticky composer. The panel can still
        // be repositioned with its drag handle when it competes with a nearby node.
        y: Math.min(7, Math.max(3, anchor.y - 5)),
      });
    }
  }, []);
  const pushToComposer = useCallback((value: string) => {
    if (nativeComposer && onPushToComposer) onPushToComposer(value);
    else setDraft((current) => appendDraft(current, value));
  }, [nativeComposer, onPushToComposer]);
  const startComposerReferenceDrag = useCallback((event: ReactPointerEvent<HTMLElement>, value: string) => {
    composerDragRef.current = { value, x: event.clientX, y: event.clientY };
  }, []);
  useEffect(() => {
    const finishComposerReferenceDrag = (event: PointerEvent) => {
      const pending = composerDragRef.current;
      composerDragRef.current = undefined;
      if (!pending || Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < 12) return;
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const localDrop = Boolean(composerInputRef.current?.contains(target));
      const nativeDrop = nativeComposer && Boolean(target?.closest('textarea, [contenteditable="true"], [role="textbox"]'));
      if (!localDrop && !nativeDrop) return;
      pushToComposer(pending.value);
      showToast(nativeComposer ? text.addedToNative : text.addedToDraft);
    };
    window.addEventListener('pointerup', finishComposerReferenceDrag);
    return () => window.removeEventListener('pointerup', finishComposerReferenceDrag);
  }, [nativeComposer, pushToComposer, showToast, text.addedToDraft, text.addedToNative]);
  const loadOlder = useCallback(async () => {
    if (!onLoadOlder || historyLoading) return;
    setHistoryLoading(true);
    try { await onLoadOlder(); } finally { setHistoryLoading(false); }
  }, [historyLoading, onLoadOlder]);
  const dropIntoDraft = (event: DragEvent<HTMLInputElement>) => {
    event.preventDefault();
    const value = event.dataTransfer.getData('text/plain');
    if (value) { setDraft((current) => appendDraft(current, value)); showToast(text.addedToDraft); }
  };

  return <main className={`spatial-app theme-${theme}`} lang={localizedLanguageTag(language)}>
    <header className="space-header">
      <div className="space-header-main">
        <div className="time-rail">
          <div className="time-rail-label"><strong>{text.time}</strong><span>{text.keyboardTimeline}</span></div>
          <div className="time-rail-slider">
            <input type="range" min={0} max={Math.max(1, maxCheckpointIndex)} step={1} value={checkpointCount ? cursorIndex : 0} disabled={!checkpointCount} onChange={(event) => { const index = Number(event.target.value); setCursorCheckpointIndex(index); moveCameraToIndex(index); setPlaying(false); }} aria-label={text.time} style={{ '--progress': `${progress}%` } as CSSProperties} />
            <div className="time-markers" aria-hidden="true">{state.checkpoints.slice(-12).map((checkpoint: SpatialCheckpoint, index, recent) => <i key={checkpoint.id} style={{ left: `${maxCheckpointIndex ? ((checkpointCount - recent.length + index) / maxCheckpointIndex) * 100 : 100}%` }} />)}</div>
          </div>
          <div className="time-rail-status"><strong aria-live="polite">{text.currentEvent} · {activeCheckpoint ? `${text.event[activeCheckpoint.kind]} #${activeCheckpoint.seq}` : '—'}</strong><small>{text.window} #{windowStartSeq}—#{windowEndSeq}</small>{cursorIndex < maxCheckpointIndex && <button className="return-live" onClick={() => { setCursorCheckpointIndex(maxCheckpointIndex); moveCameraToIndex(maxCheckpointIndex); setPlaying(true); }}>{text.follow}</button>}</div>
        </div>
        <div className="run-readout"><i className={playing ? 'live-dot' : 'paused-dot'} /><span>{playing ? text.live : text.paused}</span><code>{checkpointCount} {text.checkpoints}</code></div>
        <div className="space-actions">
          {onLoadOlder && <button className="icon-control label-control" onClick={() => void loadOlder()} disabled={historyLoading}>{historyLoading ? text.loading : text.history}</button>}
          <button className="icon-control" onClick={() => setPlaying((value) => !value)} aria-label={playing ? text.pause : text.resume}>{playing ? 'Ⅱ' : '▶'}</button>
          <button className="icon-control" onClick={() => setLanguage((value) => { const next = value === 'zh' ? 'en' : 'zh'; onLanguageChange?.(next); return next; })} aria-label={language === 'zh' ? 'Switch to English' : '切换至中文'}>{language === 'zh' ? 'EN' : '中'}</button>
          <button className="icon-control" onClick={() => setTheme((value) => { const next = value === 'dark' ? 'light' : 'dark'; onThemeChange?.(next); return next; })} aria-label={theme === 'dark' ? text.switchToLight : text.switchToDark}>{theme === 'dark' ? '☼' : '◐'}</button>
          <button className={`icon-control ${reducedMotion ? 'is-active' : ''}`} onClick={() => setReducedMotion((value) => !value)} aria-label={reducedMotion ? text.motionOn : text.motionOff}>◌</button>
          <button className={`icon-control ${guideOpen ? 'is-active' : ''}`} onClick={() => setGuideOpen((value) => !value)} aria-label={text.help}>?</button>
        </div>
      </div>
    </header>
    <section className="spatial-stage">
      {!webglFailed && <SpatialCanvas state={visibleState} selectedId={selectedId} onSelect={handleSelect} reducedMotion={reducedMotion} theme={theme} language={language} cameraNavigation={cameraNavigation} onWebGLFailure={reportWebGLFailure} />}
      {(webglFailed || !events.length) && <SceneFallback text={text} />}
      <div className="scene-orientation role-axis"><span>{text.runtime}</span><small>{layerAxisDetail}</small><b>↑</b></div>
      <div className="scene-orientation depth-axis"><b>↔</b><small>{causalAxisDetail}</small><span>{text.branch}</span></div>
      <div className="time-depth-cue" aria-hidden="true"><span>{text.past}</span><b>Z− · {text.present} · Z+</b><span>{text.future}</span></div>
      <section className={`activity-readout is-${currentActivityNarrative.state}`} aria-live="polite">
        <span>{currentActivityNarrative.label}</span><strong>{currentActivityNarrative.headline}</strong>{currentActivityNarrative.detail && <small>{currentActivityNarrative.detail}</small>}
      </section>
      {guideOpen && <section className="space-guide"><button className="quiet-button" onClick={() => setGuideOpen(false)} aria-label={text.close}>×</button><strong>{text.guideTitle}</strong><p>{text.guideText}</p><small>{text.guideControl}</small></section>}
      <FloatingInspector entity={selectedEntity} state={state} cursorSeq={cursorSeq} text={text} language={language} anchor={inspectorAnchor} nativeComposer={nativeComposer} onClose={() => setSelectedId(undefined)} onPush={pushToComposer} onToast={showToast} onReferencePointerDown={startComposerReferenceDrag} onMove={setInspectorAnchor} />
    </section>
    {!nativeComposer && <section className="standalone-composer"><div><strong>{text.standaloneLabel}</strong><span>{text.standaloneHint}</span></div><div className="composer-entry"><input ref={composerInputRef} value={draft} onChange={(event) => setDraft(event.target.value)} onDragOver={(event) => event.preventDefault()} onDrop={dropIntoDraft} placeholder={text.composerPlaceholder} aria-label={text.composerPlaceholder} /><button onClick={() => draft.trim() && showToast(text.addedToDraft)}>{text.send} ↗</button></div></section>}
    {toast && <div className="spatial-toast" role="status">{toast}</div>}
  </main>;
}

export default App;
