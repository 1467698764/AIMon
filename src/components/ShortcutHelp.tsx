import { Modal } from './primitives'

export const shortcuts: ReadonlyArray<{ keys: string[]; label: string }> = [
  { keys: ['Ctrl', 'K'], label: '打开命令面板（macOS 为 ⌘ K）' },
  { keys: ['/'], label: '聚焦搜索框' },
  { keys: ['R'], label: '刷新监控数据' },
  { keys: ['A'], label: '对所有模型测活' },
  { keys: ['N'], label: '添加站点' },
  { keys: ['F'], label: '在单站查看与全部站点之间切换' },
  { keys: ['E'], label: '展开当前范围的全部层级' },
  { keys: ['C'], label: '收起当前范围的全部层级' },
  { keys: ['J'], label: '下一个站点' },
  { keys: ['K'], label: '上一个站点' },
  { keys: ['D'], label: '切换紧凑 / 舒适密度' },
  { keys: ['T'], label: '切换浅色 / 深色主题' },
  { keys: ['?'], label: '显示此快捷键列表' },
  { keys: ['Esc'], label: '关闭浮层或清空搜索' },
]

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return <Modal title="键盘快捷键" onClose={onClose}>
    <div className="modal-body shortcut-list">
      {shortcuts.map((shortcut) => <div className="shortcut-row" key={shortcut.label}>
        <span>{shortcut.label}</span>
        <div>{shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}</div>
      </div>)}
    </div>
    <footer className="modal-footer">
      <button type="button" className="button primary" onClick={onClose}>知道了</button>
    </footer>
  </Modal>
}
