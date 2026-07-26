import { create } from 'zustand';

export type StreamStatus = 'idle' | 'streaming' | 'interrupted' | 'finished' | 'error';

export interface ChatPart {
  id: string;
  role: 'user' | 'assistant' | 'system';
  type: 'message' | 'thinking' | 'citation' | 'error' | 'status';
  text?: string;
  payload?: unknown;
}

export interface ChatThread {
  localId: string;
  sessionId?: string;
  parts: ChatPart[];
  streamStatus: StreamStatus;
}

interface SessionState {
  activeThread: ChatThread;
  appendPart: (part: ChatPart) => void;
  appendAssistantDelta: (text: string) => void;
  setSessionId: (sessionId: string) => void;
  setStreamStatus: (status: StreamStatus) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  activeThread: {
    localId: `thread_${crypto.randomUUID()}`,
    parts: [],
    streamStatus: 'idle',
  },
  appendPart: (part) =>
    set((state) => ({
      activeThread: {
        ...state.activeThread,
        parts: [...state.activeThread.parts, part],
      },
    })),
  appendAssistantDelta: (text) =>
    set((state) => {
      const parts = [...state.activeThread.parts];
      const lastPart = parts.at(-1);
      if (lastPart?.role === 'assistant' && lastPart.type === 'message') {
        parts[parts.length - 1] = {
          ...lastPart,
          text: `${lastPart.text || ''}${text}`,
        };
      } else {
        parts.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'message',
          text,
        });
      }
      return {
        activeThread: {
          ...state.activeThread,
          parts,
        },
      };
    }),
  setSessionId: (sessionId) =>
    set((state) => ({
      activeThread: {
        ...state.activeThread,
        sessionId,
      },
    })),
  setStreamStatus: (streamStatus) =>
    set((state) => ({
      activeThread: {
        ...state.activeThread,
        streamStatus,
      },
    })),
}));
