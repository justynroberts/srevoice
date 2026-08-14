import { useEffect, useState } from 'react';
import { api, type Skill } from '../lib/api';
import { Button, Callout, TextArea, TextInput, Toggle } from './ui';

const BLANK = { name: '', whenToUse: '', body: '' };

/** Mirrors the server's validation, so a bad name is caught before the round trip. */
const NAME_RULE = /^[a-z0-9][a-z0-9_]*$/;

function nameProblem(name: string, existing: Skill[], editingId?: string): string | null {
  if (!name) return null;
  if (name.length < 2) return 'Too short.';
  if (!NAME_RULE.test(name)) return 'Lowercase letters, numbers and underscores only.';
  if (existing.some((s) => s.name === name && s.id !== editingId)) {
    return 'Another skill already answers to this name.';
  }
  return null;
}

function SkillRow({
  skill,
  onEdit,
  onToggle,
  onDelete,
}: {
  skill: Skill;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  return (
    <li className="surface-card p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono-tight text-[12px] font-medium text-ink">{skill.name}</span>
            <span className="text-[10px] uppercase tracking-wider text-ink-faint">
              {skill.body.length.toLocaleString()} chars
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">{skill.whenToUse}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Toggle checked={skill.enabled} onChange={onToggle} label="" />
          <Button tone="ghost" onClick={onEdit} className="min-h-0 px-2.5 py-1.5 text-[12px]">
            Edit
          </Button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${skill.name}`}
            className="px-1 text-[13px] text-ink-faint transition-colors hover:text-critical"
          >
            ✕
          </button>
        </div>
      </div>
    </li>
  );
}

/**
 * Skills are written here and loaded by the agent on demand. The editor is
 * deliberately plain text: the body is instruction for a model, not a document,
 * and every formatting control would be a control over something that does not
 * render anywhere.
 */
export function SkillsEditor({ agentName, onChanged }: { agentName: string; onChanged: () => void }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [draft, setDraft] = useState(BLANK);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setSkills((await api.get<{ skills: Skill[] }>('/api/skills')).skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const problem = nameProblem(draft.name, skills, editingId ?? undefined);
  const canSave = Boolean(draft.name && draft.whenToUse.trim() && draft.body.trim()) && !problem;

  const reset = () => {
    setDraft(BLANK);
    setEditingId(null);
  };

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: draft.name,
        whenToUse: draft.whenToUse.trim(),
        body: draft.body.trim(),
      };
      const result = editingId
        ? await api.patch<{ skills: Skill[] }>(`/api/skills/${editingId}`, payload)
        : await api.post<{ skills: Skill[] }>('/api/skills', { ...payload, enabled: true });
      setSkills(result.skills);
      reset();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (skill: Skill, enabled: boolean) => {
    setSkills((prev) => prev.map((s) => (s.id === skill.id ? { ...s, enabled } : s)));
    try {
      await api.patch<{ skills: Skill[] }>(`/api/skills/${skill.id}`, { enabled });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      void load();
    }
  };

  const remove = async (skill: Skill) => {
    if (!window.confirm(`Delete the "${skill.name}" skill? This cannot be undone.`)) return;
    try {
      setSkills((await api.del<{ skills: Skill[] }>(`/api/skills/${skill.id}`)).skills);
      if (editingId === skill.id) reset();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-4">
      <Callout tone="info">
        Named instructions {agentName} loads only when the work calls for them. Her prompt carries
        just the name and the “when to use” line; the body arrives when she opens it. Write as much
        as you need — a long skill costs nothing until it is used.{' '}
        <strong className="font-semibold">Re-provision after changing these</strong>, since the index
        lives in her prompt.
      </Callout>

      {error && <Callout tone="error">{error}</Callout>}

      <div className="surface-card space-y-3 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          {editingId ? 'Edit skill' : 'New skill'}
        </p>

        <TextInput
          label="Name"
          mono
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value.toLowerCase() }))}
          placeholder="rundeck_job"
          hint={problem ?? 'How she refers to it. Lowercase, underscores, no spaces.'}
        />

        <TextInput
          label="When to use it"
          value={draft.whenToUse}
          onChange={(e) => setDraft((d) => ({ ...d, whenToUse: e.target.value }))}
          placeholder="Creating, validating or importing a Rundeck job."
          hint="The one line that goes in her prompt. Describe the situation, not the contents — this alone decides whether she opens it."
        />

        <TextArea
          label="Instructions"
          rows={10}
          value={draft.body}
          onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          placeholder={'# How we do this\n\n1. Draft it with…\n2. Validate before importing…'}
          hint="Loaded verbatim when she opens the skill. Never read aloud."
        />

        <div className="flex gap-2">
          <Button tone="primary" onClick={save} disabled={!canSave} loading={busy}>
            {editingId ? 'Save changes' : 'Add skill'}
          </Button>
          {editingId && (
            <Button tone="ghost" onClick={reset}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      {skills.length === 0 ? (
        <p className="py-4 text-center text-[12px] text-ink-faint">No skills yet.</p>
      ) : (
        <ul className="space-y-2">
          {skills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              onEdit={() => {
                setEditingId(skill.id);
                setDraft({ name: skill.name, whenToUse: skill.whenToUse, body: skill.body });
              }}
              onToggle={(enabled) => void toggle(skill, enabled)}
              onDelete={() => void remove(skill)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
