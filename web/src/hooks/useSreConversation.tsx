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

export type SessionPhase = 'idle' | 'requesting-mic' | 'connecting' | 'live' | 'ending' | 'reconnecting';

/** What Paige is doing right now — drives the orb. */
export type Activity = 'offline' | 'connecting' | 'listening' | 'thinking' | 'speaking';

/**
 * A dropped socket is not a finished conversation. ElevenLabs reports a clean
 * close as `reason: 'user'`; anything else — a 1006 abnormal closure from a
 * network blip, a proxy, or a laptop changing wifi — used to be handled
 * identically, so the session simply stopped mid-demo. These bound how hard we
 * try to pick it back up.
 */
/**
 * The full introduction is for meeting her; it is noise on the fourth restart of
 * a demo. So: once per page load.
 *
 * Module state on purpose, not sessionStorage — a reload is how someone starts a
 * fresh run in front of a new audience, and that audience should be introduced
 * to her. Stopping and starting within the same page is the same audience, and
 * gets the short line. A component remount is not a reload and does not reset
 * this.
 */
let introduced = false;
const SHORT_GREETING = 'How can I help?';

const MAX_RESUME_ATTEMPTS = 4;
const RESUME_BACKOFF_MS = [400, 1200, 3000, 6000];

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
  endRequested: boolean;
  /** Bumped by an unexpected disconnect; the consumer hook does the reconnect. */
  resumeToken: number;
  setPhase: (p: SessionPhase) => void;
  setEndRequested: (v: boolean) => void;
  setResumeToken: (v: number) => void;
  setProblem: (p: SessionProblem | null) => void;
  setAwaitingReply: (v: boolean) => void;
  addTurn: (role: Turn['role'], text: string) => void;
  settlePending: (result: ToolCallResponse) => void;
  clear: () => void;
  /** True while a deliberate stop is in flight. */
  stoppingRef: React.MutableRefObject<boolean>;
  /** Identifies the conversation; stable across a resume. */
  sessionIdRef: React.MutableRefObject<string>;
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
  const [endRequested, setEndRequested] = useState(false);
  const [resumeToken, setResumeToken] = useState(0);
  /**
   * Set while a deliberate stop is in flight — the End session button, or
   * session__end. Without it there is no way to tell "the engineer finished"
   * from "the socket died", and both used to end the conversation.
   */
  const stoppingRef = useRef(false);
  /**
   * Identifies this conversation. Sent with every tool call and every poll, so
   * work that finishes after a session ends is never handed to the next one —
   * a post-remediation check settling ninety seconds later would otherwise be
   * announced into whatever conversation happened to be open.
   *
   * Kept across a resume, because a reconnected conversation is the same one.
   */
  const sessionIdRef = useRef<string>('');

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
    // Handled here rather than server-side: only the browser owns the socket
    // and the microphone.
    if (tool === 'session__end') {
      setEndRequested(true);
      return 'Ending the session now. Say a brief goodbye — this is your last turn.';
    }

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
        sessionId: sessionIdRef.current || undefined,
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
      endRequested,
      resumeToken,
      setPhase,
      setProblem,
      setEndRequested,
      setResumeToken,
      setAwaitingReply,
      stoppingRef,
      sessionIdRef,
      addTurn,
      settlePending,
      clear: () => {
        setTurns([]);
        setToolCalls([]);
        setAwaitingReply(false);
      },
    }),
    [turns, toolCalls, phase, problem, awaitingReply, endRequested, resumeToken, addTurn, settlePending],
  );

  return (
    <ConversationProvider
      clientTools={clientTools}
      onConnect={() => {
        setPhase('live');
        setProblem(null);
      }}
      onDisconnect={(details?: { reason?: string; closeCode?: number; message?: string }) => {
        setAwaitingReply(false);

        // `reason: 'user'` is a clean close — the button, or session__end.
        // Anything else is the socket dying underneath a live conversation:
        // in practice a 1006 abnormal closure from a network blip or a proxy,
        // which used to look exactly like the engineer saying goodbye.
        const deliberate = stoppingRef.current || details?.reason === 'user';
        if (deliberate) {
          stoppingRef.current = false;
          setPhase('idle');
          return;
        }

        setPhase('reconnecting');
        setResumeToken((n) => n + 1);
      }}
      onError={(message: string) => {
        // Errors arrive alongside a disconnect. Record the problem but leave
        // the phase alone, or this would cancel a resume already in progress.
        setProblem({ message: message || 'Voice connection error', needs: null });
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
   * The microphone stream, kept so it can be released. Without this the tracks
   * stay live after the session ends and the browser keeps showing the
   * recording indicator — which quite reasonably reads as "it didn't end".
   */
  const micRef = useRef<MediaStream | null>(null);
  /** Consecutive failed resumes, reset by a successful connect or a real stop. */
  const resumeAttemptsRef = useRef(0);

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
        const poll = await api.get<PendingPoll>(
          `/api/mcp/pending?sessionId=${encodeURIComponent(state.sessionIdRef.current)}`,
        );
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
    phase === 'connecting' || phase === 'requesting-mic' || phase === 'reconnecting'
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
    // A fresh conversation, so a fresh id. Late work from the previous one is
    // now addressed to a session that no longer exists and will be dropped.
    state.sessionIdRef.current = nextId('session');
    setProblem(null);
    setPhase('requesting-mic');

    try {
      micRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      //
      // Full introduction on the first session of a page load, the short line
      // on every restart after it. Overriding `first_message` requires the
      // agent to permit it, which provisioning sets.
      conversation.startSession({
        signedUrl: session.signedUrl,
        ...(introduced ? { overrides: { agent: { firstMessage: SHORT_GREETING } } } : {}),
      });
      introduced = true;

      // Every session opens listening, but do NOT call setMuted here to force
      // it: the SDK throws "No active conversation" until onConnect lands, and
      // from inside this try that surfaces as a failed start. It already
      // resets mute to false on disconnect, so a new session is unmuted.

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

  const releaseMic = useCallback(() => {
    micRef.current?.getTracks().forEach((track) => track.stop());
    micRef.current = null;
  }, []);

  const stop = useCallback(async () => {
    // Flagged before endSession so onDisconnect knows this close was asked
    // for, and does not try to resume the conversation we are ending.
    state.stoppingRef.current = true;
    resumeAttemptsRef.current = 0;
    setPhase('ending');
    try {
      // Awaited: the socket teardown is asynchronous, and returning to idle
      // before it completes leaves the session half-open.
      await conversation.endSession();
    } catch {
      // Already closed, or the socket died first — either way we are done.
    } finally {
      releaseMic();
      setAwaitingReply(false);
      setPhase('idle');
    }
  }, [conversation, state, setPhase, setAwaitingReply, releaseMic]);

  /**
   * The socket dropped without anyone asking. Get a fresh signed URL and pick
   * the conversation back up, keeping the transcript and the results panel.
   *
   * A new signed URL is required rather than reusing the old one: they are
   * single-use and short-lived. The microphone stream is deliberately left
   * open — it was granted for this session and re-requesting it can put a
   * permission prompt on screen mid-demo.
   */
  useEffect(() => {
    if (state.resumeToken === 0) return;
    if (state.stoppingRef.current) return;

    const attempt = resumeAttemptsRef.current;
    if (attempt >= MAX_RESUME_ATTEMPTS) {
      setProblem({
        message: `The voice connection dropped and could not be re-established after ${MAX_RESUME_ATTEMPTS} attempts. Your transcript is intact — press Start session to carry on.`,
        needs: null,
      });
      setPhase('idle');
      resumeAttemptsRef.current = 0;
      return undefined;
    }

    let cancelled = false;
    const timer = setTimeout(
      () => {
        if (cancelled) return;
        resumeAttemptsRef.current = attempt + 1;
        void (async () => {
          try {
            const session = await api.post<SessionStart>('/api/session/start');
            if (cancelled) return;
            // Silent on resume: she was mid-sentence, and reintroducing
            // herself is the loudest possible way to announce a wobble.
            conversation.startSession({
              signedUrl: session.signedUrl,
              overrides: { agent: { firstMessage: '' } },
            });
            addTurn('system', attempt === 0 ? 'Connection dropped — reconnecting…' : 'Still reconnecting…');
          } catch {
            // Bump the token so this effect runs again for the next attempt.
            if (!cancelled) state.setResumeToken(state.resumeToken + 1);
          }
        })();
      },
      RESUME_BACKOFF_MS[Math.min(attempt, RESUME_BACKOFF_MS.length - 1)],
    );

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.resumeToken]);

  // A reconnect that lands clears the attempt counter and the warning.
  useEffect(() => {
    if (phase === 'live') {
      resumeAttemptsRef.current = 0;
    }
  }, [phase]);

  // Only a session that is genuinely over releases the microphone. A resume in
  // progress still needs it, and re-requesting mid-demo can raise a permission
  // prompt over whatever is on screen.
  useEffect(() => {
    if (phase === 'idle') releaseMic();
  }, [phase, releaseMic]);

  // Never leave the microphone open behind a closing tab or a remount.
  useEffect(() => releaseMic, [releaseMic]);

  /**
   * "That's all, thanks" should do exactly what the End session button does.
   * The tool handler lives in the provider, which cannot reach `endSession`, so
   * it raises a flag and this effect performs the teardown.
   */
  useEffect(() => {
    if (!state.endRequested) return;
    state.setEndRequested(false);
    void stop();
  }, [state, stop]);

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
