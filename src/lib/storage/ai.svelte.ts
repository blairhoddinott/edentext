// The AI assistant's settings: the kill switch and the provider the user brought.
// App-wide, one JSON key, removed while everything is at its default (off and empty);
// switching off keeps the provider so switching back on needs no retyping.

export type AiProvider = 'openai' | 'anthropic';
export type AiSettings = { enabled: boolean; provider: AiProvider; endpoint: string; apiKey: string; model: string };
export type AiConfig = Omit<AiSettings, 'enabled'>;

const KEY = 'edentext-ai';

/** Opens the popover that rewrites the selection. */
export const OPEN_AI_PROMPT_EVENT = 'edentext-ai-prompt';
/** Opens the chat pane; detail `{ prefill }` fills its field, e.g. `/draft `. */
export const OPEN_AI_CHAT_EVENT = 'edentext-ai-chat';

const DEFAULTS: AiSettings = { enabled: false, provider: 'openai', endpoint: '', apiKey: '', model: '' };

function load(): AiSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return raw && typeof raw === 'object' ? { ...DEFAULTS, ...raw, enabled: raw.enabled === true } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

let current = $state(load());

/** The kill switch: false hides every AI surface and keeps every request from going out. */
export function aiEnabled(): boolean { return current.enabled; }

export function aiSettings(): AiSettings { return current; }

/** What a request needs, or null while the assistant is off or not set up. */
export function aiConfig(): AiConfig | null {
  const { enabled, ...cfg } = current;
  return enabled && cfg.endpoint.trim() && cfg.model.trim() ? cfg : null;
}

export function setAi(patch: Partial<AiSettings>): void {
  current = { ...current, ...patch };
  const isDefault = (Object.keys(DEFAULTS) as (keyof AiSettings)[]).every((k) => current[k] === DEFAULTS[k]);
  if (isDefault) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(current));
}

// Presets fill in the address; the model stays the user's choice.
export const AI_PRESETS: { id: string; label: string; provider: AiProvider; endpoint: string }[] = [
  { id: 'openai', label: 'OpenAI', provider: 'openai', endpoint: 'https://api.openai.com/v1' },
  { id: 'anthropic', label: 'Anthropic', provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1' },
  { id: 'mistral', label: 'Mistral', provider: 'openai', endpoint: 'https://api.mistral.ai/v1' },
  { id: 'openrouter', label: 'OpenRouter', provider: 'openai', endpoint: 'https://openrouter.ai/api/v1' },
  { id: 'gemini', label: 'Google Gemini', provider: 'openai', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'ollama', label: 'Ollama', provider: 'openai', endpoint: 'http://localhost:11434/v1' },
  { id: 'lmstudio', label: 'LM Studio', provider: 'openai', endpoint: 'http://localhost:1234/v1' },
];

export function presetOf(s: AiSettings): string {
  return AI_PRESETS.find((p) => p.provider === s.provider && p.endpoint === s.endpoint)?.id ?? 'custom';
}
