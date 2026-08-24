/**
 * choice-popup — 链接/产物点击后的双按钮选择浮窗（纯 DOM，单例）。
 *
 * 在点击坐标处弹一张小卡片：两个动作按钮 + 遮罩（点击外部或 Esc 关闭）。
 * 浮窗固定定位在视口内，靠近右/下边缘时自动翻转方向，避免溢出。
 * 与 link-intercept / produced-intercept 配合：拦截点击后由用户
 * 显式选择动作，不再静默吞掉点击（「点不动」的根因）。
 */

export interface ChoiceAction {
  label: string
  onPick: () => void
}

let currentCleanup: (() => void) | null = null

/** 关闭当前浮窗（若有）。 */
export function closeChoicePopup(): void {
  if (currentCleanup !== null) {
    const cleanup = currentCleanup
    currentCleanup = null
    cleanup()
  }
}

/** 在 (x, y) 处弹出双按钮选择浮窗。 */
export function showChoicePopup(x: number, y: number, actions: ChoiceAction[]): void {
  closeChoicePopup()

  const overlay = document.createElement('div')
  overlay.setAttribute('data-dbs-choice-overlay', '1')
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99998;background:transparent;'

  const card = document.createElement('div')
  card.setAttribute('data-dbs-choice-card', '1')
  card.style.cssText = [
    'position:fixed',
    'z-index:99999',
    'display:flex',
    'flex-direction:column',
    'gap:4px',
    'min-width:148px',
    'padding:6px',
    'border-radius:10px',
    'background:var(--dsw-alias-bg-layer-2, #1b1f27)',
    'border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12))',
    'box-shadow:0 12px 32px rgba(0,0,0,0.45)',
    'font-family:var(--dsw-alias-font-family, system-ui, sans-serif)',
  ].join(';')

  const btnStyle = [
    'border:none',
    'border-radius:7px',
    'padding:7px 12px',
    'font-size:13px',
    'text-align:left',
    'cursor:pointer',
    'color:var(--dsw-alias-label-primary, #e6e9f0)',
    'background:transparent',
  ].join(';')
  const btnHover = [
    'border:none',
    'border-radius:7px',
    'padding:7px 12px',
    'font-size:13px',
    'text-align:left',
    'cursor:pointer',
    'color:var(--dsw-alias-label-primary, #e6e9f0)',
    'background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08))',
  ].join(';')

  const buttons: HTMLButtonElement[] = []
  for (const action of actions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = action.label
    button.style.cssText = btnStyle
    button.addEventListener('mouseenter', () => { button.style.cssText = btnHover })
    button.addEventListener('mouseleave', () => { button.style.cssText = btnStyle })
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      closeChoicePopup()
      action.onPick()
    })
    card.appendChild(button)
    buttons.push(button)
  }

  const dispose = (): void => {
    overlay.remove()
    card.remove()
    window.removeEventListener('keydown', onKeydown)
  }
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeChoicePopup()
  }
  overlay.addEventListener('mousedown', () => { closeChoicePopup() })
  window.addEventListener('keydown', onKeydown)

  document.body.appendChild(overlay)
  document.body.appendChild(card)

  // 定位：默认在点击点右下方，靠近右/下边缘时翻转。
  const margin = 10
  const rect = card.getBoundingClientRect()
  let left = x + margin
  let top = y + margin
  if (left + rect.width > window.innerWidth - margin) left = Math.max(margin, x - rect.width - margin)
  if (top + rect.height > window.innerHeight - margin) top = Math.max(margin, y - rect.height - margin)
  card.style.left = `${left}px`
  card.style.top = `${top}px`

  buttons[0]?.focus()
  currentCleanup = dispose
}
