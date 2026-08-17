import { useEffect, useState } from 'react';
import App from '../App';
import { ensureSpatialStyles } from '../styles';
import type { HarnessEvent } from '../types';

export interface SpatialViewSnapshot {
  events: readonly HarnessEvent[];
  sessionId?: string;
  hasOlder?: boolean;
}

interface ConversationSnapshotLike {
  views: { get(target: string): unknown };
}

export interface SpatialHarnessViewProps {
  useSession: <T>(selector: (snapshot: ConversationSnapshotLike) => T) => T;
  sessionId: string;
  loadOlder: () => Promise<void>;
  pushToComposer: (value: string) => void;
  initialTheme: 'dark' | 'light';
  initialLanguage: 'zh' | 'en';
  subscribeTheme: (listener: () => void) => () => void;
  subscribeLanguage: (listener: () => void) => () => void;
  readTheme: () => 'dark' | 'light';
  readLanguage: () => 'zh' | 'en';
}

/** Session-scoped slot component. The framework supplies useSession and sessionId. */
export function SpatialHarnessView({
  useSession, sessionId, loadOlder, pushToComposer, initialTheme, initialLanguage, subscribeTheme, subscribeLanguage, readTheme, readLanguage,
}: SpatialHarnessViewProps) {
  const snapshot = useSession((conversation) => conversation.views.get('spatial') as SpatialViewSnapshot | undefined);
  const [theme, setTheme] = useState(initialTheme);
  const [language, setLanguage] = useState(initialLanguage);
  useEffect(() => ensureSpatialStyles(), []);
  useEffect(() => { setTheme(initialTheme); return subscribeTheme(() => setTheme(readTheme())); }, [initialTheme, readTheme, subscribeTheme]);
  useEffect(() => { setLanguage(initialLanguage); return subscribeLanguage(() => setLanguage(readLanguage())); }, [initialLanguage, readLanguage, subscribeLanguage]);
  return <App harnessEvents={snapshot?.events ?? []} harnessSessionId={snapshot?.sessionId ?? sessionId} fixtureReplay={false} nativeComposer onLoadOlder={loadOlder} onPushToComposer={pushToComposer} initialTheme={theme} initialLanguage={language} />;
}
