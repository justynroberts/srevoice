import { z } from 'zod';

/**
 * A remote MCP endpoint the SRE agent can reach. `headers` carries whatever the
 * provider needs — PagerDuty's hosted MCP uses `Authorization: Bearer <token>`.
 */
export const mcpServerSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/, 'id must be lowercase alphanumeric, - or _'),
  label: z.string().min(1).max(80),
  url: z.string().url().refine((u) => u.startsWith('https://') || u.startsWith('http://localhost') || u.startsWith('http://127.0.0.1'), {
    message: 'MCP URL must be https (http allowed only for localhost)',
  }),
  headers: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
});

export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export const voiceSettingsSchema = z.object({
  voiceId: z.string().min(1).default('cjVigY5qzO86Huf0OWal'),
  modelId: z.string().min(1).default('eleven_flash_v2_5'),
  stability: z.number().min(0).max(1).default(0.45),
  similarityBoost: z.number().min(0).max(1).default(0.8),
  speed: z.number().min(0.7).max(1.2).default(1.05),
});

export const agentSettingsSchema = z.object({
  name: z.string().min(1).max(80).default('SRE Voice'),
  llm: z.string().min(1).default('claude-sonnet-4-5'),
  temperature: z.number().min(0).max(1).default(0.1),
  language: z.string().min(2).max(8).default('en'),
  firstMessage: z
    .string()
    .max(500)
    .default("SRE console online. Ask me about incidents, services, or who's on call."),
  systemPrompt: z.string().max(20000).optional(),
  maxDurationSeconds: z.number().int().min(60).max(3600).default(1800),
});

export const settingsSchema = z.object({
  version: z.literal(1).default(1),
  elevenlabsApiKey: z.string().min(1).optional(),
  voice: voiceSettingsSchema.default({}),
  agent: agentSettingsSchema.default({}),
  mcpServers: z.array(mcpServerSchema).max(10).default([]),
  /** Populated by provisioning; not user-editable. */
  provisioned: z
    .object({
      agentId: z.string().optional(),
      toolIds: z.record(z.string()).default({}),
      lastSyncedAt: z.string().optional(),
      toolCount: z.number().int().default(0),
    })
    .default({}),
  updatedAt: z.string().optional(),
});

export type Settings = z.infer<typeof settingsSchema>;
export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;
export type AgentSettings = z.infer<typeof agentSettingsSchema>;

export function emptySettings(): Settings {
  return settingsSchema.parse({});
}

/**
 * The payload the browser is allowed to see. Secrets collapse to a masked
 * preview plus a boolean — enough to render "configured", never enough to leak.
 */
export function redactSettings(s: Settings, mask: (v?: string | null) => string | null) {
  return {
    version: s.version,
    elevenlabs: {
      configured: Boolean(s.elevenlabsApiKey),
      preview: mask(s.elevenlabsApiKey),
    },
    voice: s.voice,
    agent: s.agent,
    mcpServers: s.mcpServers.map((m) => ({
      id: m.id,
      label: m.label,
      url: m.url,
      enabled: m.enabled,
      headerNames: Object.keys(m.headers),
      headerPreviews: Object.fromEntries(
        Object.entries(m.headers).map(([k, v]) => [k, mask(v)]),
      ),
    })),
    provisioned: s.provisioned,
    updatedAt: s.updatedAt,
  };
}
