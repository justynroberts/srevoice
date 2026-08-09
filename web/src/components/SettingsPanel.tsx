import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  api,
  getAccessToken,
  setAccessToken,
  type LlmOption,
  type ProvisionReport,
  type ServerStatus,
  type SettingsOptions,
  type SettingsView,
} from '../lib/api';
import {
  blankDraft,
  draftToPayload,
  McpServerEditor,
  toDraft,
  type DraftServer,
} from './McpServerEditor';
import { Button, Callout, Combo, Slider, TextArea, TextInput, Select } from './ui';

/**
 * Voices, reasoning models and TTS models all come from ElevenLabs at runtime
 * via /api/settings/options — never hardcoded. The lists below exist only so
 * the fields are usable before a working API key is saved, and both fields
 * stay free text so an unlisted identifier is always enterable.
 */
const LLM_FALLBACK: LlmOption[] = [
  { id: 'gemini-2.5-flash', deprecated: false, sunsetting: false, replacement: null, supportsParallelToolCalls: true, maxContext: null },
  { id: 'gpt-4o', deprecated: false, sunsetting: false, replacement: null, supportsParallelToolCalls: true, maxContext: null },
];

const TTS_FALLBACK = [
  { id: 'eleven_flash_v2_5', name: 'Flash v2.5' },
  { id: 'eleven_turbo_v2_5', name: 'Turbo v2.5' },
];

/**
 * Warns about the two things that silently degrade a voice SRE agent: a model
 * on its way out, and one that cannot call tools in parallel — which turns a
 * multi-lookup question into a slow serial chain.
 */
function llmHint(llms: LlmOption[], selected: string): ReactNode {
  if (llms.length === 0) return 'Runs inside ElevenLabs on their credentials — no LLM key needed. Save a working API key to load the live model list.';

  const match = llms.find((m) => m.id === selected);
  if (!match) {
    return `Not in your account's ${llms.length} available models — ElevenLabs will reject it on provision unless it is newer than this list.`;
  }
  if (match.deprecated) {
    return `Deprecated${match.replacement ? `; ElevenLabs suggests ${match.replacement}` : ''}. Pick another before it stops responding.`;
  }
  if (match.sunsetting) {
    return `Being retired${match.replacement ? `; replacement is ${match.replacement}` : ''}. Still works for now.`;
  }
  if (!match.supportsParallelToolCalls) {
    return 'This model cannot call tools in parallel, so multi-lookup questions run serially and feel slow out loud.';
  }
  return `Live from your account (${llms.length} available). Billed by ElevenLabs, no LLM key needed.`;
}

const TAB_TRIGGER =
  'rounded-lg px-3 py-1.5 text-[12px] font-medium text-ink-faint transition-colors hover:text-ink-dim data-[state=active]:bg-raised data-[state=active]:text-ink';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  statuses: ServerStatus[];
  onChanged: () => void;
}

export function SettingsPanel({ open, onOpenChange, statuses, onChanged }: Props) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [defaultPrompt, setDefaultPrompt] = useState('');
  const [drafts, setDrafts] = useState<DraftServer[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [token, setToken] = useState(getAccessToken());
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const [llms, setLlms] = useState<LlmOption[]>([]);
  const [ttsModels, setTtsModels] = useState<{ id: string; name: string }[]>([]);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [report, setReport] = useState<ProvisionReport | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ settings: SettingsView; defaultSystemPrompt: string }>('/api/settings');
      setSettings(res.settings);
      setDefaultPrompt(res.defaultSystemPrompt);
      setDrafts(res.settings.mcpServers.map(toDraft));
      if (res.settings.elevenlabs.configured) {
        const opts = await api.get<SettingsOptions>('/api/settings/options');
        setVoices(opts.voices);
        setLlms(opts.llms);
        setTtsModels(opts.ttsModels);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const patchSettings = (patch: Partial<SettingsView>) =>
    setSettings((s) => (s ? { ...s, ...patch } : s));

  const save = async (): Promise<boolean> => {
    if (!settings) return false;
    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      setAccessToken(token.trim());
      const res = await api.put<{ settings: SettingsView; mcpStatus: ServerStatus[] }>('/api/settings', {
        ...(apiKey.trim() ? { elevenlabsApiKey: apiKey.trim() } : {}),
        voice: settings.voice,
        agent: settings.agent,
        mcpServers: drafts.filter((d) => d.id && d.url).map(draftToPayload),
      });
      setSettings(res.settings);
      setDrafts(res.settings.mcpServers.map(toDraft));
      setApiKey('');
      setNotice('Saved.');
      onChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const verify = async () => {
    setVerifying(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.post<{ ok: boolean; subscriptionTier?: string }>(
        '/api/settings/verify-elevenlabs',
        apiKey.trim() ? { apiKey: apiKey.trim() } : {},
      );
      setNotice(`ElevenLabs key works${res.subscriptionTier ? ` (${res.subscriptionTier} plan)` : ''}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  };

  /** Saving first means provisioning never runs against stale config. */
  const saveAndProvision = async () => {
    const saved = await save();
    if (!saved) return;

    setProvisioning(true);
    setError(null);
    setReport(null);
    try {
      const res = await api.post<ProvisionReport>('/api/provision');
      setReport(res);
      setNotice(null);
      onChanged();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProvisioning(false);
    }
  };

  const reconnect = async (id: string) => {
    setReconnectingId(id);
    try {
      await api.post('/api/mcp/reconnect', { id });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReconnectingId(null);
    }
  };

  const statusFor = (id: string) => statuses.find((s) => s.id === id);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-void/80 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-line bg-surface shadow-2xl focus:outline-none">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold text-ink">Settings</Dialog.Title>
              <Dialog.Description className="text-[12px] text-ink-faint">
                Keys are encrypted on the server and never sent back to this page.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button tone="ghost" className="px-2.5 py-1.5" aria-label="Close settings">
                ✕
              </Button>
            </Dialog.Close>
          </div>

          {loading ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-ink-faint">Loading…</div>
          ) : !settings ? (
            /*
              Settings could not be read — almost always a missing access token.
              This is the one screen that must work without one, or there is no
              way to supply it.
            */
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
              {error && <Callout tone="error">{error}</Callout>}
              <TextInput
                label="Access token"
                type="password"
                mono
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="matches SREVOICE_ACCESS_TOKEN"
                hint="Set by the server operator. Stored in this browser only."
              />
              <div>
                <Button
                  tone="primary"
                  onClick={() => {
                    setAccessToken(token.trim());
                    void load();
                    onChanged();
                  }}
                >
                  Unlock console
                </Button>
              </div>
            </div>
          ) : (
            <Tabs.Root defaultValue="connections" className="flex min-h-0 flex-1 flex-col">
              <Tabs.List className="flex gap-1 border-b border-line px-4 py-2">
                <Tabs.Trigger value="connections" className={TAB_TRIGGER}>
                  Connections
                </Tabs.Trigger>
                <Tabs.Trigger value="voice" className={TAB_TRIGGER}>
                  Voice
                </Tabs.Trigger>
                <Tabs.Trigger value="agent" className={TAB_TRIGGER}>
                  Agent
                </Tabs.Trigger>
              </Tabs.List>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <Tabs.Content value="connections" className="space-y-5 focus:outline-none">
                  <section className="space-y-3">
                    <h3 className="text-[13px] font-semibold text-ink">ElevenLabs</h3>
                    <TextInput
                      label="API key"
                      type="password"
                      mono
                      autoComplete="off"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={
                        settings.elevenlabs.configured
                          ? `${settings.elevenlabs.preview} — leave blank to keep`
                          : 'sk_…'
                      }
                      hint="Needs Agents access. Sealed with AES-256-GCM before it touches disk."
                    />
                    <Button tone="ghost" onClick={verify} loading={verifying}>
                      Test key
                    </Button>
                  </section>

                  <section className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-[13px] font-semibold text-ink">MCP servers</h3>
                      <Button
                        tone="ghost"
                        onClick={() => setDrafts((d) => [...d, blankDraft(d.length)])}
                        className="px-2.5 py-1.5 text-[12px]"
                      >
                        + Add server
                      </Button>
                    </div>

                    {drafts.length === 0 && (
                      <Callout tone="info">
                        Add PagerDuty’s SRE agent MCP and incident MCP endpoints here. Their tools become the
                        agent’s tools.
                      </Callout>
                    )}

                    <div className="space-y-3">
                      {drafts.map((draft, i) => (
                        <McpServerEditor
                          key={i}
                          draft={draft}
                          status={statusFor(draft.id)}
                          reconnecting={reconnectingId === draft.id}
                          onReconnect={() => reconnect(draft.id)}
                          onChange={(next) => setDrafts((d) => d.map((x, j) => (j === i ? next : x)))}
                          onRemove={() => setDrafts((d) => d.filter((_, j) => j !== i))}
                        />
                      ))}
                    </div>
                  </section>

                  <section className="space-y-3">
                    <h3 className="text-[13px] font-semibold text-ink">This console</h3>
                    <TextInput
                      label="Access token"
                      type="password"
                      mono
                      autoComplete="off"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="matches SREVOICE_ACCESS_TOKEN"
                      hint="Stored in this browser only. Required when the server sets SREVOICE_ACCESS_TOKEN."
                    />
                  </section>
                </Tabs.Content>

                <Tabs.Content value="voice" className="space-y-4 focus:outline-none">
                  <Select
                    label="Voice"
                    value={settings.voice.voiceId}
                    onChange={(e) =>
                      patchSettings({ voice: { ...settings.voice, voiceId: (e.target as HTMLSelectElement).value } })
                    }
                    options={
                      voices.length
                        ? voices.map((v) => ({ value: v.id, label: v.name }))
                        : [{ value: settings.voice.voiceId, label: settings.voice.voiceId }]
                    }
                    hint={voices.length ? undefined : 'Save a working API key to load your voice library.'}
                  />
                  <Combo
                    label="Model"
                    value={settings.voice.modelId}
                    onChange={(e) => patchSettings({ voice: { ...settings.voice, modelId: e.target.value } })}
                    suggestions={(ttsModels.length ? ttsModels : TTS_FALLBACK).map((m) => ({
                      value: m.id,
                      label: m.name,
                    }))}
                    hint={
                      ttsModels.length
                        ? 'Live from your ElevenLabs account. Flash keeps replies snappy, which matters more than timbre during an incident.'
                        : 'Save a working API key to load the current model list.'
                    }
                  />
                  <Slider
                    label="Stability"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.voice.stability}
                    onChange={(stability) => patchSettings({ voice: { ...settings.voice, stability } })}
                    hint="Lower is more expressive; higher is more consistent."
                  />
                  <Slider
                    label="Similarity"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.voice.similarityBoost}
                    onChange={(similarityBoost) => patchSettings({ voice: { ...settings.voice, similarityBoost } })}
                  />
                  <Slider
                    label="Speed"
                    min={0.7}
                    max={1.2}
                    step={0.05}
                    value={settings.voice.speed}
                    onChange={(speed) => patchSettings({ voice: { ...settings.voice, speed } })}
                    format={(v) => `${v.toFixed(2)}×`}
                  />
                </Tabs.Content>

                <Tabs.Content value="agent" className="space-y-4 focus:outline-none">
                  <TextInput
                    label="Agent name"
                    value={settings.agent.name}
                    onChange={(e) => patchSettings({ agent: { ...settings.agent, name: e.target.value } })}
                  />
                  <Combo
                    label="Reasoning model"
                    value={settings.agent.llm}
                    onChange={(e) => patchSettings({ agent: { ...settings.agent, llm: e.target.value } })}
                    suggestions={(llms.length ? llms : LLM_FALLBACK).map((m) => ({
                      value: m.id,
                      label: [
                        m.deprecated ? 'deprecated' : m.sunsetting ? 'sunsetting' : null,
                        m.supportsParallelToolCalls ? null : 'no parallel tools',
                      ]
                        .filter(Boolean)
                        .join(' · ') || undefined,
                    }))}
                    hint={llmHint(llms, settings.agent.llm)}
                  />
                  <TextInput
                    label="Opening line"
                    value={settings.agent.firstMessage}
                    onChange={(e) => patchSettings({ agent: { ...settings.agent, firstMessage: e.target.value } })}
                  />
                  <Slider
                    label="Temperature"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.agent.temperature}
                    onChange={(temperature) => patchSettings({ agent: { ...settings.agent, temperature } })}
                    hint="Keep it low. Incident answers should be boring and repeatable."
                  />
                  <TextArea
                    label="System prompt"
                    rows={14}
                    value={settings.agent.systemPrompt ?? defaultPrompt}
                    onChange={(e) => patchSettings({ agent: { ...settings.agent, systemPrompt: e.target.value } })}
                    hint="The live tool catalogue is appended automatically on every provision."
                  />
                  <Button
                    tone="ghost"
                    onClick={() => patchSettings({ agent: { ...settings.agent, systemPrompt: defaultPrompt } })}
                  >
                    Reset to default prompt
                  </Button>
                </Tabs.Content>
              </div>

              <div className="space-y-3 border-t border-line px-5 py-4">
                {error && <Callout tone="error">{error}</Callout>}
                {notice && <Callout tone="ok">{notice}</Callout>}
                {report && (
                  <Callout tone={report.warnings.length ? 'warn' : 'ok'}>
                    <p className="font-medium">
                      Agent ready with {report.toolCount} tool{report.toolCount === 1 ? '' : 's'} — {report.created.length}{' '}
                      added, {report.updated.length} updated, {report.removed.length} removed.
                    </p>
                    {report.warnings.map((w, i) => (
                      <p key={i} className="mt-1 opacity-90">
                        {w}
                      </p>
                    ))}
                  </Callout>
                )}

                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11px] text-ink-faint">
                    {settings.provisioned.lastSyncedAt
                      ? `Last provisioned ${new Date(settings.provisioned.lastSyncedAt).toLocaleString()}`
                      : 'Not provisioned yet'}
                  </p>
                  <div className="flex gap-2">
                    <Button tone="ghost" onClick={save} loading={saving}>
                      Save
                    </Button>
                    <Button tone="primary" onClick={saveAndProvision} loading={provisioning}>
                      Save &amp; provision agent
                    </Button>
                  </div>
                </div>
              </div>
            </Tabs.Root>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
