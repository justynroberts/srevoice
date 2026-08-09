import { useConversation } from '@elevenlabs/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { api, ApiError, type SessionStart, type ToolCallResponse } from '../lib/api';

export interface Turn {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  at: number;
}

export interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: 'running' | 'ok' | 'error';
  result?: ToolCallResponse;
  error?: string;
  startedAt: number;
  durationMs?: number;
}

export type SessionPhase = 'idle' | 'requesting-mic' | 'connecting' | 'live' | 'ending';

export interface SessionProblem {
  message: string;
  needs: 'apiKey' | 'provision' | 'mic' | null;
}

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${seq++}`;

/**
 * Owns the voice session and everything it produces: the spoken transcript and
 * the tool calls behind it.
 *
 * The agent's tools are ElevenLabs *client* tools, so every invocation lands
 * here in the browser. Each one is forwarded to this app's server, which holds
 * the MCP credentials and does the actual call. The agent gets back a short
 * spoken summary; the screen gets the full payload from the same response.
 */
export function useSreConversation(toolNames: string[]) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [problem, setProblem] = useState<SessionProblem | null>(null);

  // Read inside tool handlers, which are created once and must not close over
  // a stale render's state.
  const activeCalls = useRef(new Map<string, string>());

  const addTurn = useCallback((role: Turn['role'], text: string) => {
    const clean = text?.trim();
    if (!clean) return;
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      // The SDK emits partial transcripts that grow; collapse a turn that is
      // just the previous one extended, otherwise the log stutters.
      if (last && last.role === role && clean.startsWith(last.text) && clean !== last.text) {
        return [...prev.slice(0, -1), { ...last, text: clean }];
      }
      if (last && last.role === role && last.text === clean) return prev;
      return [...prev, { id: nextId('turn'), role, text: clean, at: Date.now() }];
    });
  }, []);

  const runTool = useCallback(
    async (tool: string, params: Record<string, unknown>): Promise<string> => {
      const callId = nextId('call');
      activeCalls.current.set(callId, tool);

      setToolCalls((prev) => [
        ...prev,
        { id: callId, tool, args: params ?? {}, status: 'running', startedAt: Date.now() },
      ]);

      try {
        const result = await api.post<ToolCallResponse>('/api/mcp/call', {
          tool,
          args: params ?? {},
          callId,
        });

        setToolCalls((prev) =>
          prev.map((c) =>
            c.id === callId
              ? {
                  ...c,
                  status: result.ok ? 'ok' : 'error',
                  result,
                  durationMs: result.durationMs,
                  error: result.ok ? undefined : result.speech,
                }
              : c,
          ),
        );
        return result.speech;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setToolCalls((prev) =>
          prev.map((c) =>
            c.id === callId
              ? { ...c, status: 'error', error: message, durationMs: Date.now() - c.startedAt }
              : c,
          ),
        );
        // Returned, not thrown: the agent should explain the failure out loud
        // rather than have the tool call collapse silently.
        return `The ${tool} call could not be completed: ${message}`;
      } finally {
        activeCalls.current.delete(callId);
      }
    },
    [],
  );

  const clientTools = useMemo(() => {
    const handlers: Record<string, (params: Record<string, unknown>) => Promise<string>> = {};
    for (const name of toolNames) {
      handlers[name] = (params) => runTool(name, params);
    }
    return handlers;
  }, [toolNames, runTool]);

  const conversation = useConversation({
    clientTools,
    onConnect: () => {
      setPhase('live');
      setProblem(null);
    },
    onDisconnect: () => {
      setPhase('idle');
    },
    onError: (error: unknown) => {
      const message = typeof error === 'string' ? error : ((error as Error)?.message ?? 'Voice connection error');
      setProblem({ message, needs: null });
      setPhase('idle');
    },
    onMessage: (payload: unknown) => {
      const msg = payload as { message?: string; source?: string; type?: string };
      const text = msg?.message;
      if (typeof text !== 'string' || !text.trim()) return;
      // `source` is 'user' for transcripts and 'ai' for agent replies.
      addTurn(msg.source === 'user' ? 'user' : 'agent', text);
    },
  });

  const start = useCallback(async () => {
    setProblem(null);
    setPhase('requesting-mic');

    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPhase('idle');
      setProblem({
        message: 'Microphone access was blocked. Allow it in your browser, then start again.',
        needs: 'mic',
      });
      return;
    }

    setPhase('connecting');
    try {
      const session = await api.post<SessionStart>('/api/session/start');
      await conversation.startSession({ signedUrl: session.signedUrl });
      addTurn('system', 'Session started.');
    } catch (err) {
      setPhase('idle');
      if (err instanceof ApiError) {
        setProblem({ message: err.message, needs: err.needs });
      } else {
        setProblem({ message: err instanceof Error ? err.message : String(err), needs: null });
      }
    }
  }, [conversation, addTurn]);

  const stop = useCallback(async () => {
    setPhase('ending');
    try {
      await conversation.endSession();
    } finally {
      setPhase('idle');
    }
  }, [conversation]);

  const clear = useCallback(() => {
    setTurns([]);
    setToolCalls([]);
  }, []);

  const sendText = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean || phase !== 'live') return;
      conversation.sendUserMessage(clean);
      addTurn('user', clean);
    },
    [conversation, phase, addTurn],
  );

  return {
    turns,
    toolCalls,
    phase,
    problem,
    isSpeaking: conversation.isSpeaking,
    status: conversation.status,
    isMuted: Boolean((conversation as { isMuted?: boolean }).isMuted),
    setMuted: (conversation as { setMuted?: (m: boolean) => void }).setMuted,
    start,
    stop,
    clear,
    sendText,
    dismissProblem: () => setProblem(null),
  };
}
