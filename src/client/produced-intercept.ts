/**
 * produced-intercept — 回合结束产物 chips 的点击拦截。
 *
 * 官方 ui-deliverables 把一轮的产出文件渲染为 `[data-produced-files-row]`
 * 内的 chips（title 为完整路径，点击走官方 openFile，常表现为「点不动」）。
 * 本模块在 document capture 阶段拦截点击：先删掉默认行为，弹双按钮
 * 「侧边栏编辑器打开 / 系统打开」，由用户显式选择。
 *
 * 产物是本地文件（文本类），第一动作永远是侧边栏编辑器；「系统打开」
 * 走 webui 的 file-explorer open-in-explorer 路由（整合包内可用）。
 */

import { showChoicePopup } from './choice-popup.ts'

/** 提取路径的 basename（同时兼容 / 与 \ 分隔）。 */
export function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/**
 * Register the document-level click capture for produced-file chips.
 * Returns the disposer (HMR-safe).
 */
export function registerProducedInterception(opts: {
  /** Open the path in the sidebar editor tab. */
  openInEditor: (path: string) => void
}): () => void {
  const onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented) return
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const target = event.target
    if (target === null || typeof (target as Element).closest !== 'function') return
    const chip = (target as Element).closest<HTMLButtonElement>('[data-produced-files-row] button[title]')
    if (chip === null) return
    const path = chip.getAttribute('title') ?? ''
    if (path === '') return
    event.preventDefault()
    event.stopPropagation()
    const rect = chip.getBoundingClientRect()
    showChoicePopup(rect.left, rect.bottom, [
      {
        label: '侧边栏编辑器打开',
        onPick: () => { opts.openInEditor(path) },
      },
      {
        label: '系统打开',
        onPick: () => {
          fetch('/api/file-explorer/open-in-explorer', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path }),
          }).catch(() => { /* 路由不存在（webui 未装）时静默 */ })
        },
      },
    ])
  }
  document.addEventListener('click', onClick, true)
  return () => { document.removeEventListener('click', onClick, true) }
}
