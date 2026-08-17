import { SpatialHarnessView } from './spatial-view';
import type { SpatialViewSnapshot } from './spatial-view';
import type { HarnessEvent } from '../types';

const NS = 'spatial';
const PACKAGE_ID = 'spatial-trajectory';

type RawSessionEvent = {
  type: string;
  seq: number;
  time: number;
  data?: unknown;
  surfaceOp?: unknown;
  sourceEventSeqs?: number[];
};

type ConversationMatch = {
  event: RawSessionEvent;
};

type ConversationDefinition = {
  kind: string;
  target: string;
  match(event: RawSessionEvent): { id: string; role: 'start' | 'update' } | null;
  start(context: { matches: readonly ConversationMatch[] }, match: ConversationMatch): { event: RawSessionEvent };
  update(context: { matches: readonly ConversationMatch[] }, match: ConversationMatch): { event: RawSessionEvent };
  buildViewNode(context: { key: string; id: string; matches: readonly ConversationMatch[]; start?: ConversationMatch }): {
    key: string;
    kind: string;
    id: string;
    target: string;
    data: HarnessEvent;
  } | null;
};

interface SpatialViewBuilder {
  readonly empty: SpatialViewSnapshot;
  replace(input: { nodes: readonly SpatialViewNode[]; timeline: unknown }): SpatialViewSnapshot;
  apply(input: { upserts: readonly SpatialViewNode[]; timeline: unknown }): SpatialViewSnapshot;
}

interface SpatialViewNode {
  key: string;
  kind: string;
  id: string;
  target: 'spatial';
  data: HarnessEvent;
}

interface SpatialClientContext {
  effect?: (factory: () => void | (() => void), name?: string) => unknown;
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): void | (() => void);
    bind(namespace: string): (key: string) => string;
    getLocale(): { active: string };
    setLocale(id: string): void;
  };
  theme: {
    getTheme(): { active: { colorScheme: 'dark' | 'light' } };
    setTheme(id: string): void;
  };
  on(event: 'theme/change' | 'locale/change', listener: () => void): () => void;
  slots: {
    inject(name: string, factory: () => unknown): unknown;
    register(options: Record<string, unknown>, component: unknown): unknown;
  };
  conversationEvents: { register(definition: ConversationDefinition): unknown };
  conversationViews: { register(definition: { target: string; create(): SpatialViewBuilder }): unknown };
  sessions: { binding(sessionId: string): { session?: { loadOlder(): Promise<void> }; ctx: object } | undefined };
  conversation: {
    input: {
      for(scope: object): {
        state: { getSnapshot(): { draft: string } };
        setDraft(text: string): void;
      };
    };
  };
}

export const inject = ['slots', 'conversationEvents', 'conversationViews', 'sessions', 'locale', 'theme', 'conversation'];

export const spatialClientManifest = {
  id: PACKAGE_ID,
  viewId: 'spatial',
  testedAgainst: '@deepseek-ai/dsh 0.1.0-rc.6',
};

const dictionaries = {
  zh: { 'view.spatial': '空间轨迹' },
  en: { 'view.spatial': 'Spatial' },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nestedToolResult(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const message = asRecord(data.message);
  const content = Array.isArray(message.content) ? message.content : [];
  return content.map(asRecord).find((block) => block.type === 'tool-result');
}

function isHumanPrompt(event: HarnessEvent): boolean {
  const type = event.type.toLowerCase();
  const data = asRecord(event.data);
  const role = typeof data.role === 'string' ? data.role.toLowerCase() : '';
  const isUserMessage = type.includes('user/message') || (type.includes('message/') && role === 'user');
  if (!isUserMessage) return false;
  const source = asRecord(data.source);
  // Keep the same boundary as Chat: runtime/plugin user-role records are context,
  // whereas a real human prompt remains the causal start of its station.
  return !Object.keys(source).length || source.kind === 'user';
}

function toHarnessEvent(event: RawSessionEvent): HarnessEvent {
  const payload = asRecord(event.data);
  const data: Record<string, unknown> = {
    ...payload,
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
    ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }),
  };
  if (event.type === 'tool/call') {
    if (typeof data.toolName !== 'string' && typeof data.name === 'string') data.toolName = data.name;
    if (data.input === undefined && data.arguments !== undefined) data.input = data.arguments;
  }
  if (event.type === 'tool/result') {
    const message = asRecord(data.message);
    const source = asRecord(message.source);
    const result = nestedToolResult(data);
    // The Harness result envelope places the causal call id and visible tool
    // content below `message`. Lift only these references; the full raw event
    // is still retained by the view node for replay and inspection.
    if (typeof data.callId !== 'string' && typeof source.callId === 'string') data.callId = source.callId;
    if (typeof data.callId !== 'string' && typeof result?.toolCallId === 'string') data.callId = result.toolCallId;
    if (data.output === undefined) data.output = result?.content ?? data.message;
  }
  return { sessionId: 'harness-session', seq: event.seq, timestamp: event.time, type: event.type, data };
}

function createSpatialView(): SpatialViewBuilder {
  const nodes = new Map<string, SpatialViewNode>();
  const snapshot = (currentTimeline: unknown): SpatialViewSnapshot => ({
    events: [...nodes.values()].map((node) => node.data).sort((a, b) => a.seq - b.seq),
    hasOlder: false,
    sessionId: undefined,
    // Keep the runtime timeline available for a later inspector without coupling App to it.
    ...(currentTimeline ? { timeline: currentTimeline } : {}),
  } as SpatialViewSnapshot);
  return {
    empty: { events: [], hasOlder: false },
    replace(input) {
      // Conversation timelines may retain only a recent event tail when the view
      // refreshes. Do not let that refresh erase the human prompt that started a
      // long-running turn; App renders it as the station's left-hand anchor.
      const retainedPrompts = [...nodes.values()].filter((node) => isHumanPrompt(node.data));
      nodes.clear();
      for (const node of input.nodes) nodes.set(node.key, node);
      for (const prompt of retainedPrompts) if (!nodes.has(prompt.key)) nodes.set(prompt.key, prompt);
      return snapshot(input.timeline);
    },
    apply(input) {
      for (const node of input.upserts) nodes.set(node.key, node);
      return snapshot(input.timeline);
    },
  };
}

const spatialEventDefinition: ConversationDefinition = {
  kind: 'spatial-event',
  target: 'spatial',
  match(event) {
    return { id: String(event.seq), role: 'start' };
  },
  start(_context, match) {
    return { event: match.event };
  },
  update(context) {
    return { event: context.matches.at(-1)?.event ?? { type: 'unknown', seq: 0, time: 0 } };
  },
  buildViewNode(context) {
    const event = context.matches.at(-1)?.event ?? context.start?.event;
    if (!event) return null;
    return { key: context.key, kind: 'spatial-event', id: context.id, target: 'spatial', data: toHarnessEvent(event) };
  },
};

export function applySpatialClientPlugin(ctx: SpatialClientContext): void {
  const registerLocale = () => ctx.locale.register(NS, dictionaries);
  if (ctx.effect) ctx.effect(registerLocale, 'spatial: dictionaries');
  else registerLocale();
  const t = ctx.locale.bind(NS);

  ctx.conversationEvents.register(spatialEventDefinition);
  ctx.conversationViews.register({ target: 'spatial', create: createSpatialView });
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'spatial',
    order: 20,
    locale: NS,
    label: () => t('view.spatial'),
    inject: (sessionId: string) => {
      const binding = ctx.sessions.binding(sessionId);
      if (!binding?.session) throw new Error(`spatial: session "${sessionId}" is unavailable`);
      return {
        loadOlder: () => binding.session!.loadOlder(),
        pushToComposer: (value: string) => {
          const input = ctx.conversation.input.for(binding.ctx);
          const draft = input.state.getSnapshot().draft;
          input.setDraft(`${draft}${draft.trim() ? '\n\n' : ''}${value}`);
        },
        initialTheme: ctx.theme.getTheme().active.colorScheme,
        initialLanguage: ctx.locale.getLocale().active.startsWith('zh') ? 'zh' : 'en',
        subscribeTheme: (listener: () => void) => ctx.on('theme/change', listener),
        subscribeLanguage: (listener: () => void) => ctx.on('locale/change', listener),
        readTheme: () => ctx.theme.getTheme().active.colorScheme,
        readLanguage: () => ctx.locale.getLocale().active.startsWith('zh') ? 'zh' : 'en',
      };
    },
  }, SpatialHarnessView));
}
