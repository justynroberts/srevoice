import { useCallback, useEffect, useRef, useState } from 'react';
import { Console } from './components/Console';
import { SettingsPanel } from './components/SettingsPanel';
import { Button, Callout } from './components/ui';
import { SreConversationProvider } from './hooks/useSreConversation';
import { api, ApiError, type CatalogueTool, type ServerStatus } from './lib/api';

interface Bootstrap {
  tools: string[];
  statuses: ServerStatus[];
  agentName: string;
}

export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<{ message: string; unauthorised: boolean } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // A 401 on first load means no token has been pasted yet. Opening Settings
  // unprompted is the whole remedy, so do it once rather than making the
  // operator find the gear behind an error banner.
  const promptedForToken = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [catalogue, status, settings] = await Promise.all([
        api.get<{ tools: CatalogueTool[] }>('/api/mcp/catalogue'),
        api.get<{ servers: ServerStatus[] }>('/api/mcp/status'),
        api.get<{ settings: { agent: { name: string } } }>('/api/settings'),
      ]);
      setBoot({
        tools: catalogue.tools.map((t) => t.name),
        statuses: status.servers,
        agentName: settings.settings.agent.name || 'Paige',
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
      if (unauthorised && !promptedForToken.current) {
        promptedForToken.current = true;
        setSettingsOpen(true);
      }
      // Without a catalogue there are no client tools to register, so the voice
      // session stays unavailable until this resolves.
      setBoot({ tools: [], statuses: [], agentName: 'Paige' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Reflect MCP health without forcing the operator to reopen Settings.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!settingsOpen) void refresh();
    }, 30_000);
    return () => clearInterval(interval);
  }, [refresh, settingsOpen]);

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
        onChanged={() => void refresh()}
      />
    </div>
  );
}
