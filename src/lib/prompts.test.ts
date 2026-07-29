import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROMPTS, PROMPT_MAX_LENGTH, promptLibrary, promptTitle } from './prompts.js'

function stubStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
    },
  })
  return store
}

describe('custom health-check prompt library', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('ships the built-in question on a first run but honours a cleared library', () => {
    stubStorage()
    expect(promptLibrary.list()).toEqual(DEFAULT_PROMPTS)

    stubStorage({ 'aimon-health-prompts': '[]' })
    expect(promptLibrary.list()).toEqual([])
  })

  it('drops damaged entries and backfills a title from the question itself', () => {
    stubStorage({
      'aimon-health-prompts': JSON.stringify([
        { id: 'a', title: '', text: '第一行问题\n第二行' },
        { id: 'b', title: '空的', text: '   ' },
        'not-an-object',
      ]),
    })

    expect(promptLibrary.list()).toEqual([{ id: 'a', title: '第一行问题', text: '第一行问题\n第二行' }])
  })

  it('remembers the last used question and falls back to the built-in one', () => {
    stubStorage()
    expect(promptLibrary.lastUsed()).toBe(DEFAULT_PROMPTS[0].text)

    promptLibrary.setLastUsed('上次用过的问题')
    expect(promptLibrary.lastUsed()).toBe('上次用过的问题')

    promptLibrary.setLastUsed('')
    expect(promptLibrary.lastUsed()).toBe('')
  })

  it('caps the library at 50 entries and the question at the server limit', () => {
    stubStorage()
    const saved = promptLibrary.save(Array.from({ length: 60 }, (_, index) => ({
      id: `p${index}`, title: `问题 ${index}`, text: 'x'.repeat(PROMPT_MAX_LENGTH + 10),
    })))

    expect(saved).toHaveLength(50)
    expect(promptLibrary.list()[0].text).toHaveLength(PROMPT_MAX_LENGTH)
  })

  it('labels an unnamed question by its first non-empty line', () => {
    expect(promptTitle('\n\n  统计一下  \n更多内容')).toBe('统计一下')
    expect(promptTitle('')).toBe('未命名问题')
    expect(promptTitle('一'.repeat(40))).toBe(`${'一'.repeat(24)}…`)
  })
})
