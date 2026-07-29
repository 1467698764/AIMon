export interface SavedPrompt {
  id: string
  title: string
  text: string
}

const keys = {
  library: 'aimon-health-prompts',
  last: 'aimon-health-prompt-last',
} as const

const DEFAULT_PROMPT_TEXT = `题目
在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表：

|          | 苹果味 | 桃子味 | 西瓜味 |
|----------|--------|--------|--------|
| 圆形     | 7      | 9      | 8      |
| 五角星形 | 7      | 6      | 4      |

参赛者需要在活动前决定摸出的糖果数目。问：最少取出多少个糖果，才能保证手中**同时拥有不同形状的苹果味和桃子味的糖**？（说明：同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果，都满足要求。）`

export const DEFAULT_PROMPTS: SavedPrompt[] = [
  { id: 'preset-candy', title: '糖果推理题', text: DEFAULT_PROMPT_TEXT },
]

export const PROMPT_MAX_LENGTH = 8_000

function read(key: string): string | null {
  if (typeof window === 'undefined') return null
  try { return window.localStorage.getItem(key) } catch { return null }
}

function write(key: string, value: string): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(key, value) } catch { /* The prompt library is best-effort only. */ }
}

function sanitize(prompt: unknown): SavedPrompt | null {
  if (!prompt || typeof prompt !== 'object') return null
  const record = prompt as Record<string, unknown>
  const text = typeof record.text === 'string' ? record.text.slice(0, PROMPT_MAX_LENGTH) : ''
  if (!text.trim()) return null
  return {
    id: typeof record.id === 'string' && record.id ? record.id : createPromptId(),
    title: (typeof record.title === 'string' ? record.title : '').slice(0, 60).trim() || promptTitle(text),
    text,
  }
}

export function createPromptId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** A saved question needs a label even when the user never typed one. */
export function promptTitle(text: string): string {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '未命名问题'
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine
}

export const promptLibrary = {
  list(): SavedPrompt[] {
    const stored = read(keys.library)
    // An absent key means a first run; an empty array means the user cleared the library.
    if (stored == null) return DEFAULT_PROMPTS.map((prompt) => ({ ...prompt }))
    try {
      const parsed = JSON.parse(stored)
      if (!Array.isArray(parsed)) return []
      return parsed.map(sanitize).filter((prompt): prompt is SavedPrompt => prompt !== null).slice(0, 50)
    } catch {
      return []
    }
  },
  save(prompts: SavedPrompt[]): SavedPrompt[] {
    const next = prompts.slice(0, 50)
    write(keys.library, JSON.stringify(next))
    return next
  },
  lastUsed(): string {
    const stored = read(keys.last)
    if (stored != null) return stored.slice(0, PROMPT_MAX_LENGTH)
    return DEFAULT_PROMPTS[0]?.text || ''
  },
  setLastUsed(text: string): void {
    write(keys.last, text.slice(0, PROMPT_MAX_LENGTH))
  },
}
