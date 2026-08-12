import { ConversationProvider, useConversation } from '@elevenlabs/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  ApiError,
  type PendingPoll,
  type SessionStart,
  type ToolCallResponse,
} from '../lib/api';

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
  status: 'running' | 'pending' | 'ok' | 'error';
  result?: ToolCallResponse;
  error?: string;
  startedAt: number;
  durationMs?: number;
}

export type SessionPhase = 'idle' | 'requesting-mic' | 'connecting' | 'live' | 'ending';

/** What Paige is doing right now — drives the orb. */
export type Activity = 'offline' | 'connecting' | 'listening' | 'thinking' | 'speaking';

export interface SessionProblem {
  message: string;
  needs: 'apiKey' | 'provision' | 'mic' | null;
}

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${seq++}`;

interface SreState {
  turns: Turn[];
  toolCalls: ToolCall[];
  phase: SessionPhase;
  problem: SessionProblem | null;
  awaitingReply: boolean;
  setPhase: (p: SessionPhase) => void;
  setProblem: (p: SessionProblem | null) => void;
  setAwaitingReply: (v: boolean) => void;
  addTurn: (role: Turn['role'], text: string) => void;
  settlePending: (result: ToolCallResponse) => void;
  clear: () => void;
}

const SreStateContext = createContext<SreState | null>(null);

/**
 * Wraps ElevenLabs' `ConversationProvider` and owns everything the session
 * produces — the transcript and the tool calls behind it.
 *
 * The provider has to sit above any component calling `useConversation`, and
 * it needs `clientTools` at construction, which is why the tool handlers and
 * the state they write to live here rather than in the consuming component.
 */
export function SreConversationProvider({
  toolNames,
  children,
}: {
  toolNames: string[];
  children: ReactNode;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [problem, setProblem] = useState<SessionProblem | null>(null);
  const [awaitingReply, setAwaitingReply] = useState(false);

  const addTurn = useCallback((role: Turn['role'], text: string) => {
    const clean = text?.trim();
    if (!clean) return;
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      // Partial transcripts arrive as the same turn, growing. Collapse them or
      // the log stutters one fragment at a time.
      if (last && last.role === role && clean.startsWith(last.text) && clean !== last.text) {
        return [...prev.slice(0, -1), { ...last, text: clean }];
      }
      if (last && last.role === role && last.text === clean) return prev;
      return [...prev, { id: nextId('turn'), role, text: clean, at: Date.now() }];
    });
  }, []);

  const runTool = useCallback(async (tool: string, params: Record<string, unknown>): Promise<string> => {
    const callId = nextId('call');
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
                // A pending call is still running server-side; its real result
                // arrives later through the pending poll.
                status: result.pending ? 'pending' : result.ok ? 'ok' : 'error',
                result: result.pending ? undefined : result,
                durationMs: result.pending ? undefined : result.durationMs,
                error: result.pending || result.ok ? undefined : result.speech,
              }
            : c,
        ),
      );
      return result.speech;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setToolCalls((prev) =>
        prev.map((c) =>
          c.id === callId ? { ...c, status: 'error', error: message, durationMs: Date.now() - c.startedAt } : c,
        ),
      );
      // Returned rather than thrown: the agent should say what failed, not have
      // the tool call vanish.
      return `The ${tool} call could not be completed: ${message}`;
    }
  }, []);

  /**
   * A call that outran its turn finishing later. Matched by callId so the card
   * that was left spinning is the one that updates.
   */
  const settlePending = useCallback((result: ToolCallResponse) => {
    setToolCalls((prev) =>
      prev.map((c) =>
        c.id === result.callId
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
  }, []);

  const clientTools = useMemo(() => {
    const handlers: Record<string, (params: Record<string, unknown>) => Promise<string>> = {};
    for (const name of toolNames) handlers[name] = (params) => runTool(name, params);
    return handlers;
  }, [toolNames, runTool]);

  const state = useMemo<SreState>(
    () => ({
      turns,
      toolCalls,
      phase,
      problem,
      awaitingReply,
      setPhase,
      setProblem,
      setAwaitingReply,
      addTurn,
      settlePending,
      clear: () => {
        setTurns([]);
        setToolCalls([]);
        setAwaitingReply(false);
      },
    }),
    [turns, toolCalls, phase, problem, awaitingReply, addTurn, settlePending],
  );

  return (
    <ConversationProvider
      clientTools={clientTools}
      onConnect={() => {
        setPhase('live');
        setProblem(null);
      }}
      onDisconnect={() => {
        setPhase('idle');
        setAwaitingReply(false);
      }}
      onError={(message: string) => {
        setProblem({ message: message || 'Voice connection error', needs: null });
        setPhase('idle');
      }}
      onMessage={({ message, role, source }) => {
        // `role` supersedes the deprecated `source`; both are present today.
        const speaker = role ?? source;
        const isUser = speaker === 'user';
        // A finished user transcript means the turn is now hers — she is
        // thinking until she either speaks or calls a tool.
        setAwaitingReply(isUser);
        addTurn(isUser ? 'user' : 'agent', message);
      }}
    >
      <SreStateContext.Provider value={state}>{children}</SreStateContext.Provider>
    </ConversationProvider>
  );
}

/** Must be called inside `SreConversationProvider`. */
export function useSreConversation() {
  const state = useContext(SreStateContext);
  if (!state) throw new Error('useSreConversation must be used within SreConversationProvider');

  const conversation = useConversation();
  const { setPhase, setProblem, setAwaitingReply, addTurn, settlePending, phase } = state;
  const startingRef = useRef(false);

  /**
   * Results that outran their turn.
   *
   * ElevenLabs abandons a client tool after two minutes, and an engineer
   * talking over her ends the turn sooner than that — but the query is still
   * running and its answer is still wanted. Polling here is independent of the
   * conversation, so an interruption no longer throws the work away: whatever
   * lands is handed back as a contextual update, which she can weave in without
   * being asked again.
   */
  useEffect(() => {
    if (phase !== 'live') return undefined;

    let cancelled = false;
    const tick = async () => {
      try {
        const poll = await api.get<PendingPoll>('/api/mcp/pending');
        if (cancelled) return;
        for (const settled of poll.settled) {
          settlePending(settled);
          // Phrased as a note about the world, not as an instruction: an
          // imperative here gets read out verbatim.
          const preamble = settled.ok
            ? `[Background] The earlier ${settled.tool} lookup has just come back. The engineer has not seen this yet and may have moved on, so it is worth mentioning briefly with a word about what it relates to.`
            : `[Background] The earlier ${settled.tool} lookup failed.`;
          conversation.sendContextualUpdate(`${preamble}\n\n${settled.speech}`);
          addTurn('system', `Late result: ${settled.tool}`);
        }
      } catch {
        // A failed poll is not worth surfacing — the next tick retries, and the
        // session is unaffected.
      }
    };

    const interval = setInterval(() => void tick(), 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [phase, conversation, settlePending, addTurn]);

  const toolRunning = state.toolCalls.some((c) => c.status === 'running');

  /**
   * Speaking wins over thinking: once audio starts the reply has clearly begun.
   * A running tool call is the strongest thinking signal, and the gap after a
   * user transcript covers the rest.
   */
  const activity: Activity =
    phase === 'connecting' || phase === 'requesting-mic'
      ? 'connecting'
      : phase !== 'live'
        ? 'offline'
        : conversation.isSpeaking
          ? 'speaking'
          : toolRunning || state.awaitingReply
            ? 'thinking'
            : 'listening';

  const start = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
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
      startingRef.current = false;
      return;
    }

    setPhase('connecting');
    try {
      const [session, briefing] = await Promise.all([
        api.post<SessionStart>('/api/session/start'),
        // Best-effort: no memory is not a reason to fail the session.
        api.get<{ text: string }>('/api/memory/briefing').catch(() => ({ text: '' })),
      ]);

      // Synchronous: failures after this point surface through onError, and
      // onConnect is what moves the phase to 'live'.
      conversation.startSession({ signedUrl: session.signedUrl });

      // Sent as context rather than baked into the prompt at provision time, so
      // something learned an hour ago is available without re-provisioning.
      if (briefing.text) {
        setTimeout(() => {
          try {
            conversation.sendContextualUpdate(briefing.text);
          } catch {
            // The session ended before the socket was ready — nothing to do.
          }
        }, 1200);
      }
    } catch (err) {
      setPhase('idle');
      if (err instanceof ApiError) setProblem({ message: err.message, needs: err.needs });
      else setProblem({ message: err instanceof Error ? err.message : String(err), needs: null });
    } finally {
      startingRef.current = false;
    }
  }, [conversation, setPhase, setProblem]);

  const stop = useCallback(() => {
    setPhase('ending');
    conversation.endSession();
    setPhase('idle');
  }, [conversation, setPhase]);

  // She has answered — stop showing the thinking state. In an effect rather
  // than during render: the flag lives in the provider above this hook.
  const speaking = conversation.isSpeaking;
  useEffect(() => {
    if (speaking) setAwaitingReply(false);
  }, [speaking, setAwaitingReply]);

  const sendText = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean || phase !== 'live') return;
      conversation.sendUserMessage(clean);
      addTurn('user', clean);
      setAwaitingReply(true);
    },
    [conversation, phase, addTurn, setAwaitingReply],
  );

  return {
    turns: state.turns,
    toolCalls: state.toolCalls,
    phase: state.phase,
    problem: state.problem,
    activity,
    isSpeaking: conversation.isSpeaking,
    status: conversation.status,
    isMuted: conversation.isMuted,
    setMuted: conversation.setMuted,
    start,
    stop,
    clear: state.clear,
    sendText,
    dismissProblem: () => setProblem(null),
  };
}
