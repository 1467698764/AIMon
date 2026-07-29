import { useRef, useState } from 'react'
import { BookmarkPlus, FilePlus2, MessageSquareText, Play, Trash2 } from 'lucide-react'
import { PROMPT_MAX_LENGTH, createPromptId, promptLibrary, promptTitle, type SavedPrompt } from '../lib/prompts'
import { IconButton, Modal } from './primitives'

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 72 ? `${flat.slice(0, 72)}…` : flat
}

/** The prefilled question is usually one of the saved ones; adopting it avoids saving a duplicate. */
function matchSaved(library: SavedPrompt[], text: string): SavedPrompt | null {
  const trimmed = text.trim()
  return trimmed ? library.find((item) => item.text.trim() === trimmed) || null : null
}

export function PromptModal({ scopeLabel, targetHint, onClose, onRun }: {
  scopeLabel: string
  targetHint: string
  onClose: () => void
  onRun: (prompt: string) => void
}) {
  const [initial] = useState(() => {
    const list = promptLibrary.list()
    const last = promptLibrary.lastUsed()
    return { list, last, saved: matchSaved(list, last) }
  })
  const [library, setLibrary] = useState<SavedPrompt[]>(initial.list)
  const [text, setText] = useState(initial.last)
  const [title, setTitle] = useState(initial.saved?.title || '')
  const [activeId, setActiveId] = useState<string | null>(initial.saved?.id || null)
  const [notice, setNotice] = useState('')
  const editorRef = useRef<HTMLTextAreaElement>(null)

  const trimmed = text.trim()
  const active = activeId == null ? null : library.find((item) => item.id === activeId) || null
  const label = title.trim() || promptTitle(trimmed)
  const changed = active != null && (active.text !== trimmed || active.title !== label)

  function commit(next: SavedPrompt[], message: string) {
    setLibrary(promptLibrary.save(next))
    setNotice(message)
  }

  function select(prompt: SavedPrompt) {
    setActiveId(prompt.id)
    setText(prompt.text)
    setTitle(prompt.title)
    setNotice('')
    editorRef.current?.focus()
  }

  /** Keeps the text but forgets which saved question it came from, so a save creates a new one. */
  function detach() {
    setActiveId(null)
    setTitle('')
    setNotice('')
    editorRef.current?.focus()
  }
  function saveCurrent() {
    if (!trimmed) return
    if (active) {
      commit(library.map((item) => item.id === active.id ? { ...item, title: label, text: trimmed } : item), '常用问题已更新')
      setTitle(label)
      return
    }
    if (library.length >= 50) {
      setNotice('常用问题已达 50 条上限，请先删除一些')
      return
    }
    const created: SavedPrompt = { id: createPromptId(), title: label, text: trimmed }
    commit([created, ...library], '已存为常用问题')
    setActiveId(created.id)
    setTitle(label)
  }

  function remove(prompt: SavedPrompt) {
    commit(library.filter((item) => item.id !== prompt.id), `已删除“${prompt.title}”`)
    if (activeId === prompt.id) {
      setActiveId(null)
      setTitle('')
    }
  }

  function run() {
    if (!trimmed) return
    promptLibrary.setLastUsed(trimmed)
    onRun(trimmed)
  }

  return <Modal title={`自定义测活 · ${scopeLabel}`} onClose={onClose} wide>
    <div className="modal-body prompt-modal-body">
      <p className="prompt-intro">
        <MessageSquareText size={15} />
        <span>把你自己的问题发给{targetHint}，测活详情会保留每次请求的回复原文，方便直接比较模型答得对不对。</span>
      </p>
      <section className="prompt-library">
        <header>
          <h3>常用问题</h3>
          <span>{library.length ? `已保存 ${library.length} 条` : '暂无保存的问题'}</span>
        </header>
        {library.length > 0 ? <div className="prompt-list">
          {library.map((prompt) => <div className={`prompt-row ${prompt.id === activeId ? 'selected' : ''}`} key={prompt.id}>
            <button
              type="button"
              className="prompt-pick"
              title={prompt.id === activeId ? '正在编辑这个问题' : '载入并编辑这个问题'}
              onClick={() => select(prompt)}
            >
              <strong>{prompt.title}</strong>
              <small>{preview(prompt.text)}</small>
            </button>
            <IconButton title={`删除“${prompt.title}”`} tone="danger" onClick={() => remove(prompt)}><Trash2 size={14} /></IconButton>
          </div>)}
        </div> : <div className="empty-inline">写好问题后可以存为常用，下次直接选用。</div>}
      </section>
      <section className="prompt-editor">
        <header>
          <h3>{active ? `编辑：${active.title}` : '本次问题'}</h3>
          {active && <button type="button" className="button compact ghost" onClick={detach}>
            <FilePlus2 size={14} />另存为新问题
          </button>}
          <button
            type="button"
            className="button compact"
            disabled={!trimmed || (active != null && !changed)}
            title={active ? '把修改写回这条常用问题' : '把当前问题存入常用列表'}
            onClick={saveCurrent}
          ><BookmarkPlus size={14} />{active ? '保存修改' : '存为常用'}</button>
        </header>
        <label>
          <span>问题名称</span>
          <input value={title} maxLength={60} placeholder={promptTitle(trimmed)} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          <span>问题内容</span>
          <textarea
            ref={editorRef}
            className="prompt-text"
            value={text}
            rows={12}
            maxLength={PROMPT_MAX_LENGTH}
            placeholder="输入要发给模型的问题，例如一道推理题。"
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <div className="prompt-meta">
          <span>{trimmed.length} / {PROMPT_MAX_LENGTH} 字</span>
          {notice && <em>{notice}</em>}
        </div>
      </section>
    </div>
    <footer className="modal-footer">
      <button type="button" className="button ghost" onClick={onClose}>取消</button>
      <button type="button" className="button primary" disabled={!trimmed} onClick={run}>
        <Play size={15} />开始测活
      </button>
    </footer>
  </Modal>
}
