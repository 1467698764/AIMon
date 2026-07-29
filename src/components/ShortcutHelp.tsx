import { Modal } from './primitives'

export const shortcuts: ReadonlyArray<{ keys: string[]; label: string; group: string }> = [
  { group: '全局操作', keys: ['Ctrl', 'K'], label: '打开命令面板（macOS 为 ⌘ K）' },
  { group: '全局操作', keys: ['/'], label: '聚焦搜索框' },
  { group: '全局操作', keys: ['R'], label: '刷新监控数据' },
  { group: '全局操作', keys: ['A'], label: '对所有模型测活' },
  { group: '全局操作', keys: ['P'], label: '用自定义问题对所有模型测活' },
  { group: '全局操作', keys: ['N'], label: '添加站点' },
  { group: '浏览与导航', keys: ['F'], label: '在单站查看与全部站点之间切换' },
  { group: '浏览与导航', keys: ['E'], label: '展开当前范围的全部层级' },
  { group: '浏览与导航', keys: ['C'], label: '收起当前范围的全部层级' },
  { group: '浏览与导航', keys: ['J'], label: '下一个站点' },
  { group: '浏览与导航', keys: ['K'], label: '上一个站点' },
  { group: '外观与帮助', keys: ['D'], label: '切换紧凑 / 舒适密度' },
  { group: '外观与帮助', keys: ['T'], label: '切换浅色 / 深色主题' },
  { group: '外观与帮助', keys: ['?'], label: '显示此快捷键列表' },
  { group: '外观与帮助', keys: ['Esc'], label: '关闭浮层或清空搜索' },
]

const groups = [...new Set(shortcuts.map((shortcut) => shortcut.group))]

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return <Modal title="键盘快捷键" onClose={onClose}>
    <div className="modal-body shortcut-list">
      {groups.map((group) => <section className="shortcut-group" key={group}>
        <h3>{group}</h3>
        {shortcuts.filter((shortcut) => shortcut.group === group).map((shortcut) => <div className="shortcut-row" key={shortcut.label}>
          <span>{shortcut.label}</span>
          <div>{shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}</div>
        </div>)}
      </section>)}
    </div>
    <footer className="modal-footer">
      <button type="button" className="button primary" onClick={onClose}>知道了</button>
    </footer>
  </Modal>
}
