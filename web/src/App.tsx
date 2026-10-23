import { useCallback, useEffect, useRef, useState } from 'react';
import { Console } from './components/Console';
import { PhoneStage, wantsPhoneView } from './components/PhoneStage';
import { SettingsPanel } from './components/SettingsPanel';
import { SignIn } from './components/SignIn';
import { Button, Callout } from './components/ui';
import { SreConversationProvider } from './hooks/useSreConversation';
import { api, ApiError, SIGNED_OUT_EVENT, type CatalogueTool, type ServerStatus } from './lib/api';

interface Bootstrap {
  tools: string[];
  statuses: ServerStatus[];
  agentName: string;
}

/**
 * The health poll returns freshly allocated arrays every 30 seconds, so
 * storing its result unconditionally re-rendered the whole console on a timer
 * even when nothing had changed. Every transcript turn and tool card carries a
 * Framer `layout` prop, which re-measures on each render — visible as a
 * periodic flicker. Compare on the fields that are actually rendered and keep
 * the previous object when they match, so React can bail out.
 */
function sameBootstrap(a: Bootstrap | null, b: Bootstrap): boolean {
  if (!a) return false;
  if (a.agentName !== b.agentName) return false;
  if (a.tools.length !== b.tools.length || a.tools.some((t, i) => t !== b.tools[i])) return false;
  if (a.statuses.length !== b.statuses.length) return false;
  return a.statuses.every((s, i) => {
    const o = b.statuses[i];
    return (
      s.id === o.id &&
      s.state === o.state &&
      s.enabled === o.enabled &&
      s.toolCount === o.toolCount &&
      s.error === o.error &&
      s.label === o.label
    );
  });
}

/**
 * Asks the server whether sign-in is required before anything else loads, so a
 * locked console shows its front door rather than a page of 401s.
 */
export default function App() {
  const [auth, setAuth] = useState<'checking' | 'signed-in' | 'signed-out'>('checking');

  const checkAuth = useCallback(async () => {
    try {
      const me = await api.get<{ authenticated: boolean }>('/api/auth/me');
      setAuth(me.authenticated ? 'signed-in' : 'signed-out');
    } catch {
      // An older server without /api/auth: carry on as before.
      setAuth('signed-in');
    }
  }, []);

  useEffect(() => {
    void checkAuth();
    const onSignedOut = () => setAuth('signed-out');
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [checkAuth]);

  if (auth === 'checking') return <div className="h-full bg-black" />;
  if (auth === 'signed-out') return <SignIn onSignedIn={() => setAuth('signed-in')} />;
  return <ConsoleShell phone={wantsPhoneView()} />;
}

function ConsoleShell({ phone }: { phone: boolean }) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<{ message: string; unauthorised: boolean } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // A 401 on first load means no token has been pasted yet. Opening Settings
  // unprompted is the whole remedy, so do it once rather than making the
  // operator find the gear behind an error banner.
  const promptedForToken = useRef(false);

  /**
   * `adoptTools` is false for the background poll.
   *
   * The conversation provider is keyed on the tool list, because ElevenLabs
   * takes client-tool handlers at construction. That makes any change to the
   * list a full remount — which drops the live session and wipes the transcript
   * and results panel. A transient MCP blip during the poll must not do that,
   * and new tools are useless mid-session anyway: the agent only learns about
   * them when it is re-provisioned. So the list is adopted on first load and
   * after an explicit settings change, never from the poll.
   */
  const refresh = useCallback(async (adoptTools = false) => {
    try {
      const [catalogue, status, settings] = await Promise.all([
        api.get<{ tools: CatalogueTool[] }>('/api/mcp/catalogue'),
        api.get<{ servers: ServerStatus[] }>('/api/mcp/status'),
        api.get<{ settings: { agent: { name: string } } }>('/api/settings'),
      ]);
      setBoot((prev) => {
        const next: Bootstrap = {
          tools: adoptTools || !prev ? catalogue.tools.map((t) => t.name) : prev.tools,
          statuses: status.servers,
          agentName: settings.settings.agent.name || 'Paige',
        };
        return sameBootstrap(prev, next) ? prev : next;
      });
      setError(null);
    } catch (err) {
      const unauthorised = err instanceof ApiError && err.status === 401;
      setError({
        message: unauthorised
          ? 'This console needs an access token. Add it under Settings → Connections.'
          : err instanceof Error
            ? err.message
            : String(err),
        unauthorised,
      });
      // The phone has no Settings to open; it shows the message instead.
      if (unauthorised && !phone && !promptedForToken.current) {
        promptedForToken.current = true;
        setSettingsOpen(true);
      }
      // Without a catalogue there are no client tools to register, so the voice
      // session stays unavailable until this resolves.
      setBoot((prev) => prev ?? { tools: [], statuses: [], agentName: 'Paige' });
    }
  }, [phone]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  // Reflect MCP health without forcing the operator to reopen Settings.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!settingsOpen) void refresh();
    }, 30_000);
    return () => clearInterval(interval);
  }, [refresh, settingsOpen]);

  if (phone) {
    if (!boot) return <div className="h-full bg-black" />;
    return (
      <SreConversationProvider key={boot.tools.join('|')} toolNames={boot.tools}>
        <PhoneStage agentName={boot.agentName} problem={error?.message ?? null} />
      </SreConversationProvider>
    );
  }

  if (!boot) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-3 text-[13px] text-ink-faint">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          Connecting to the console…
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="shrink-0 px-5 pt-3">
          <Callout tone={error.unauthorised ? 'warn' : 'error'}>
            <div className="flex items-center justify-between gap-3">
              <span>{error.message}</span>
              <Button
                tone="ghost"
                onClick={() => setSettingsOpen(true)}
                className="shrink-0 px-2.5 py-1 text-[11px]"
              >
                Settings
              </Button>
            </div>
          </Callout>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {/*
          Remounted when the tool list changes: ConversationProvider takes
          clientTools at construction, so a stale set would silently drop calls
          for newly provisioned tools.
        */}
        <SreConversationProvider key={boot.tools.join('|')} toolNames={boot.tools}>
          <Console
            tools={boot.tools}
            statuses={boot.statuses}
            agentName={boot.agentName}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </SreConversationProvider>
      </div>

      <SettingsPanel
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        statuses={boot.statuses}
        onChanged={() => void refresh(true)}
      />
    </div>
  );
}
