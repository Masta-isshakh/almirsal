'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { SessionInfo } from './WebClient';

const SessionContext = createContext<SessionInfo | null>(null);

export function SessionProvider({ user, children }: { user: SessionInfo; children: ReactNode }) {
  return <SessionContext.Provider value={user}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionInfo {
  const user = useContext(SessionContext);
  if (!user) throw new Error('useSession must be used inside SessionProvider');
  return user;
}
