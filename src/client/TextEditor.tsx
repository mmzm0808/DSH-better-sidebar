/**
 * The code/markdown file viewer: a CodeMirror 6 editor with line wrapping,
 * syntax highlighting (extension-keyed language), a dirty dot and Ctrl/Cmd+S
 * save, and a preview/edit toggle for markdown files. Registered as the
 * `code` (catch-all) and `markdown` built-in viewers; the editor tab host
 * fetches the content through the fsRead strategy and passes it in props,
 * so this component never fetches or dispatches — it only edits.
 *
 * The toolbar (mode toggle / dirty dot / save / status) renders as its own
 * row below the host's title bar, VSCode-style — unless the host passes
 * `toolbar: 'host'` (the merged editor-explorer mode), in which case this
 * component skips the row and reports state + registers commands through
 * the FileViewerProps toolbar callbacks so the host's path-input header
 * renders the controls instead.
 */
import { useCallback, useLayoutEffect, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { EditorState } from '@codemirror/state'
import { EditorView as CodeMirrorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { IconCheckOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, htmlUrl } from './api.ts'
import { languageForPath } from './lang.ts'
import { cmSurfaceTheme, CmThemeCompartment } from './cm-themes.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { SandboxStatusBar } from './SandboxStatusBar.tsx'
import { appendToDraft } from './conversation-draft.ts'
import { buildSelectionInsert, linesOfSelection } from './selection-payload.ts'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import { splitMermaidBlocks, type MermaidMarkdownProps } from './mermaid-blocks.ts'
import { t } from './locales.ts'
import type { EditorToolbarState, FileViewerProps } from './service.ts'
import css from './sidebar.module.css'

/** Previewable files (rendered output vs source editing). */
type ViewMode = 'preview' | 'edit'

/** The floating "add to conversation" action: payload + viewport anchor. */
interface SelectionPopup {
  insert: string
  left: number
  top: number
}

/**
 * The chunk-resident markdown preview renderer (mermaid lazy chunk): one
 * MarkdownText pass over the whole source, with rendered mermaid fences
 * swapped for diagrams. Module-level `pick` keeps the load effect stable.
 */
const LazyMermaidMarkdown = lazyChunkComponent<MermaidMarkdownProps>(
  'mermaid',
  (mod) => mod.MermaidMarkdown as ComponentType<MermaidMarkdownProps> | undefined,
)

/**
 * Markdown preview incremental loading. Huge md files render the whole
 * document into the preview DOM and freeze the tab (MarkdownText over 512 KB
 * of source is thousands of nodes); files above {@link MD_WINDOW_MIN_LINES}
 * lines instead start with ~2× the visible lines and APPEND further segments
 * as the user scrolls near the bottom. Already-rendered segments stay in the
 * DOM (each segment is its own MarkdownText block keyed by index — appending
 * renders only the new segment, never re-parses the loaded ones), so the
 * scroll position never jumps. The window covers the preview only — edit
 * mode keeps the full document in CodeMirror, which virtualizes lines itself.
 */
const MD_WINDOW_MIN_LINES = 300
/** Average preview line height, used to estimate the viewport line count. */
const MD_LINE_HEIGHT = 24
/** Lines appended per scroll-load batch. */
const MD_LOAD_STEP_LINES = 120
/** Max loaded window span (lines). Beyond this the far end is dropped to
 *  bound the rendered DOM — scrolling deep into a huge file never lets the
 *  loaded segments grow without limit. */
const MD_MAX_WINDOW_LINES = 6000

/**
 * The sandbox tokens of the HTML preview iframe. NO allow-same-origin (the
 * preview must stay in an opaque origin — with the route's own origin it
 * could read session data) and NO allow-top-navigation (a previewed page
 * must not hijack the GUI). The user can disable the sandbox per-feature
 * in the side card settings (warned); the toggle below reflects it.
 */
export const HTML_IFRAME_SANDBOX = 'allow-scripts allow-popups allow-downloads allow-modals'

export function TextEditor(props: FileViewerProps) {
  const { ctx, scope, path, viewerId, content, truncated } = props
  const [mode, setMode] = useState<ViewMode>('preview')
  /** The editor's current text (null while clean); preview renders this. */
  const [draft, setDraft] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CodeMirrorView | null>(null)
  const savingRef = useRef(false)
  /** The theme compartment of the current view (reconfigured on scheme flip). */
  const themeCompRef = useRef<CmThemeCompartment | null>(null)
  /** The app's resolved color scheme; the editor re-themes in place on flips. */
  const [dark, setDark] = useState(() => isDarkScheme())
  /** The floating "add to conversation" popup (viewport-anchored; null = hidden). */
  const [popup, setPopup] = useState<SelectionPopup | null>(null)
  /** Live mirror of the popup state for click-time reads (no re-render race). */
  const popupRef = useRef<SelectionPopup | null>(null)
  /** The markdown preview container (selection-containment + line lookup). */
  const mdRef = useRef<HTMLDivElement>(null)

  const hidePopup = (): void => {
    popupRef.current = null
    setPopup(null)
  }

  /** Anchor the popup above the selection center; clamp inside the viewport. */
  const showPopup = (insert: string, left: number, top: number): void => {
    const next: SelectionPopup = {
      insert,
      left: Math.min(Math.max(left, 80), window.innerWidth - 80),
      top,
    }
    popupRef.current = next
    setPopup(next)
  }

  /** The popup button's click: insert the stored payload into the draft. */
  const commitPopup = (): void => {
    const current = popupRef.current
    if (current === null) return
    appendToDraft(ctx, scope.sessionId, current.insert)
    hidePopup()
  }

  useEffect(() => subscribeColorScheme(() => { setDark(isDarkScheme()) }), [])

  // A new file (tab switch) starts clean: fresh preview mode, no draft.
  useEffect(() => {
    setMode('preview')
    setDraft(null)
    setDirty(false)
    setSaveState('idle')
    hidePopup()
  }, [content])

  // Create the CodeMirror editor once the content is loaded. The view owns
  // the document; React only tracks dirty/draft state through the update
  // listener. For markdown the view stays mounted while previewing (hidden),
  // so unsaved edits survive the preview/edit toggle. The theme + syntax
  // colors live in a compartment so a scheme flip reconfigures only that
  // part — the document, undo history and scroll position survive.
  useEffect(() => {
    if (content === undefined) return
    const host = hostRef.current
    if (host === null) return
    const language = languageForPath(path)
    const themeComp = new CmThemeCompartment()
    themeCompRef.current = themeComp
    const state = EditorState.create({
      doc: content,
      extensions: [
        CodeMirrorView.lineWrapping,
        lineNumbers(),
        history(),
        EditorState.tabSize.of(2),
        CodeMirrorView.contentAttributes.of({ spellcheck: 'false' }),
        cmSurfaceTheme,
        themeComp.of(dark),
        ...(language !== null ? [language] : []),
        CodeMirrorView.updateListener.of((update) => {
          if (update.docChanged) {
            setDraft(update.state.doc.toString())
            setDirty(true)
          }
          if (update.docChanged || update.selectionSet) {
            const sel = update.state.selection.main
            setFileInfo({ total: update.state.doc.length, selected: sel.empty ? 0 : sel.to - sel.from })
          }
        }),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => { save(); return true },
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        // Selection popup (the code and markdown editors): a non-empty
        // selection anchors the floating "add to conversation" button above
        // its head. Scrolling (geometry/viewport change) or losing focus
        // hides it; typing collapses the selection and hides it too.
        ...(viewerId === 'code' || viewerId === 'markdown' ? [
          CodeMirrorView.updateListener.of((update) => {
            if (update.geometryChanged || update.viewportChanged) {
              hidePopup()
              return
            }
            if (!update.view.hasFocus) {
              hidePopup()
              return
            }
            if (!(update.selectionSet || update.docChanged || update.focusChanged)) return
            const sel = update.state.selection.main
            if (sel.empty) {
              hidePopup()
              return
            }
            const text = update.state.sliceDoc(sel.from, sel.to)
            if (text.trim() === '') {
              hidePopup()
              return
            }
            // Page coordinates (the document root may scroll); the popup is
            // position:fixed, so convert to viewport coordinates.
            const rect = update.view.coordsAtPos(sel.head)
            if (rect === null) {
              hidePopup()
              return
            }
            const doc = update.state.doc
            showPopup(
              buildSelectionInsert(path, scope.cwd, {
                start: doc.lineAt(sel.from).number,
                end: doc.lineAt(sel.to).number,
              }, text),
              rect.left - window.scrollX + (rect.right - rect.left) / 2,
              rect.top - window.scrollY,
            )
          }),
        ] : []),
      ],
    })
    const view = new CodeMirrorView({ state, parent: host })
    viewRef.current = view
    setFileInfo({ total: content.length, selected: 0 })
    return () => {
      view.destroy()
      viewRef.current = null
      themeCompRef.current = null
    }
    // The keymap's save() reads live refs; scope/path are stable for a
    // tab's lifetime, and the dark flip is handled by the reconfigure
    // effect below (recreating the view here would drop the draft).
  }, [content, path])

  // Scheme flip: re-theme in place (the compartment holds only the
  // scheme-dependent extensions; everything else is untouched).
  useEffect(() => {
    const view = viewRef.current
    const themeComp = themeCompRef.current
    if (view === null || themeComp === null) return
    view.dispatch({ effects: themeComp.reconfigure(dark) })
  }, [dark])

  // The editor may have been display:none while previewing; re-measure when
  // it becomes visible again (CodeMirror sizes itself on reveal). A mode
  // flip also invalidates any anchored selection popup.
  useEffect(() => {
    hidePopup()
    if (mode === 'edit') viewRef.current?.requestMeasure()
  }, [mode])

  const save = (): void => {
    const view = viewRef.current
    if (view === null || savingRef.current) return
    savingRef.current = true
    setSaveState('saving')
    api.fsWrite(scope, path, view.state.doc.toString()).then(() => {
      savingRef.current = false
      setDraft(null)
      setDirty(false)
      setSaveState('saved')
    }).catch(() => {
      savingRef.current = false
      setSaveState('failed')
    })
  }

  const markdown = viewerId === 'markdown'
  const html = viewerId === 'html'
  /** The markdown source the preview renders (draft wins over saved content). */
  const mdText = draft ?? content ?? ''

  // ---- markdown preview windowed loading ----
  // Window = [winStart, loadedEnd) in file lines, both aligned to the
  // MD_LOAD_STEP_LINES grid so every segment's key (its start line) is
  // stable: extending the top only MOUNTS new leading segments, never
  // re-mounts the loaded ones, and the scroll offset is compensated in
  // useLayoutEffect (before paint) so the user never sees a jump.
  const [winStart, setWinStart] = useState(0)
  const [loadedEnd, setLoadedEnd] = useState<number | null>(null)
  const segRefs = useRef(new Map<number, HTMLDivElement>())
  const scrollTopRef = useRef(0)
  const lastWinStartRef = useRef(0)
  const resizeTimerRef = useRef<number | null>(null)
  /** Height of the top segments dropped by a window shrink, measured before
   *  their DOM unmounts; the layout effect applies it as scroll compensation. */
  const dropTopRef = useRef(0)
  const gridFloor = (n: number): number => Math.max(0, Math.floor(n / MD_LOAD_STEP_LINES) * MD_LOAD_STEP_LINES)
  const gridCeil = (n: number): number => {
    if (mdLines === null) return n
    return Math.min(mdLines.length, Math.ceil(n / MD_LOAD_STEP_LINES) * MD_LOAD_STEP_LINES)
  }

  /** The preview source split into lines, or null when the file is small
   *  enough to render whole (incremental mode off). */
  const mdLines = useMemo(() => {
    if (!(markdown && mode === 'preview')) return null
    const lines = mdText.split('\n')
    return lines.length >= MD_WINDOW_MIN_LINES ? lines : null
  }, [markdown, mode, mdText])

  // Seed the initial window: 2× the measured viewport lines.
  useEffect(() => {
    if (mdLines === null) {
      setLoadedEnd(null)
      return
    }
    const el = mdRef.current
    const visible = el !== null
      ? Math.max(10, Math.ceil(el.clientHeight / MD_LINE_HEIGHT))
      : 20
    lastWinStartRef.current = 0
    setWinStart(0)
    setLoadedEnd(gridCeil(Math.min(mdLines.length, visible * 2)))
  }, [mdLines])

  /** Segments covering [winStart, loadedEnd), tail-aligned to blank lines so
   *  prose/headings stay intact. Each segment renders independently keyed by
   *  its start line — appending a tail or prepending a head mounts only the
   *  new segment, never re-renders the loaded ones. */
  const mdSegments = useMemo(() => {
    if (mdLines === null || loadedEnd === null) return null
    const segs: Array<{ start: number; end: number; text: string }> = []
    let start = winStart
    while (start < loadedEnd) {
      let end = Math.min(start + MD_LOAD_STEP_LINES, loadedEnd)
      if (end < mdLines.length) {
        // Back off to the last blank line inside the segment (block intact).
        for (let i = end - 1; i > start; i--) {
          if (mdLines[i]?.trim() === '') {
            end = i + 1
            break
          }
        }
      }
      segs.push({ start, end, text: mdLines.slice(start, end).join('\n') })
      start = end
    }
    return segs
  }, [mdLines, winStart, loadedEnd])

  /** Scroll handling: append below, extend above, and shrink the far end
   *  when the loaded span exceeds {@link MD_MAX_WINDOW_LINES} — dropping top
   *  segments records their height for pre-paint scroll compensation, dropping
   *  bottom segments needs none (content the reader has not reached yet). */
  const handleMdScroll = useCallback((event: React.UIEvent<HTMLDivElement>): void => {
    hidePopup()
    const el = event.currentTarget
    scrollTopRef.current = el.scrollTop
    if (mdLines === null || loadedEnd === null) return
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
    if (remaining < el.clientHeight && loadedEnd < mdLines.length) {
      const nextEnd = gridCeil(Math.min(mdLines.length, loadedEnd + MD_LOAD_STEP_LINES))
      setLoadedEnd(nextEnd)
      if (nextEnd - winStart > MD_MAX_WINDOW_LINES) {
        const newStart = gridFloor(nextEnd - MD_MAX_WINDOW_LINES)
        if (newStart > winStart) {
          let dropped = 0
          for (const seg of mdSegments ?? []) {
            if (seg.start < newStart) {
              const segEl = segRefs.current.get(seg.start)
              if (segEl !== undefined) dropped += segEl.offsetHeight
            }
          }
          dropTopRef.current = dropped
          lastWinStartRef.current = newStart
          setWinStart(newStart)
        }
      }
      return
    }
    if (el.scrollTop < el.clientHeight && winStart > 0) {
      const newStart = gridFloor(Math.max(0, winStart - MD_LOAD_STEP_LINES))
      setWinStart(newStart)
      if (loadedEnd - newStart > MD_MAX_WINDOW_LINES) {
        setLoadedEnd(gridCeil(Math.min(mdLines.length, newStart + MD_MAX_WINDOW_LINES)))
      }
    }
  }, [mdLines, loadedEnd, winStart, mdSegments, hidePopup])

  /** Pre-paint scroll compensation when the window head moves: growing upward
   *  adds the new leading segments' measured height, shrinking upward subtracts
   *  the dropped segments' pre-unmount height. Runs before paint — no flicker. */
  useLayoutEffect(() => {
    if (winStart === lastWinStartRef.current) return
    const prevStart = lastWinStartRef.current
    lastWinStartRef.current = winStart
    const el = mdRef.current
    if (el === null) return
    let delta = 0
    if (winStart > prevStart) {
      delta = -dropTopRef.current
      dropTopRef.current = 0
    } else {
      for (const seg of mdSegments ?? []) {
        if (seg.start >= winStart && seg.start < prevStart) {
          const segEl = segRefs.current.get(seg.start)
          if (segEl !== undefined) delta += segEl.offsetHeight
        }
      }
    }
    if (delta !== 0) el.scrollTop = scrollTopRef.current + delta
  }, [winStart, mdSegments])

  /** Width changes (sidebar drag / window resize) reflow the preview lines,
   *  so the cached segments no longer match the visible content: drop the
   *  cache down to the current viewport window (2× visible lines around the
   *  scroll position) and restore the scroll proportion after the re-render
   *  — the reader stays at the same content, no flash to the top. */
  useEffect(() => {
    if (mdLines === null) return
    const onResize = (): void => {
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null
        const el = mdRef.current
        if (el === null) return
        const span = el.scrollHeight - el.clientHeight
        const p = span > 0 ? el.scrollTop / span : 0
        const topLine = Math.round(p * mdLines.length)
        const visible = Math.max(10, Math.ceil(el.clientHeight / MD_LINE_HEIGHT))
        const nextStart = gridFloor(Math.max(0, topLine - visible))
        const nextEnd = gridCeil(Math.min(mdLines.length, topLine + visible))
        lastWinStartRef.current = nextStart
        setWinStart(nextStart)
        setLoadedEnd(nextEnd)
        requestAnimationFrame(() => {
          const span2 = el.scrollHeight - el.clientHeight
          if (span2 > 0) el.scrollTop = p * span2
        })
      }, 150)
    }
    window.addEventListener('resize', onResize)
    let ro: ResizeObserver | null = null
    const mdEl = mdRef.current
    if (typeof ResizeObserver !== 'undefined' && mdEl !== null) {
      ro = new ResizeObserver(onResize)
      ro.observe(mdEl)
    }
    return () => {
      window.removeEventListener('resize', onResize)
      ro?.disconnect()
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current)
    }
  }, [mdLines])

  /** Keyboard navigation for the preview: Ctrl+Home → top, Ctrl+End → bottom
   *  (jumping a huge file resets/repositions the loaded window), PageUp /
   *  PageDown scroll one viewport. Only active in markdown preview mode and
   *  never when typing in an input/textarea/contenteditable (CodeMirror has
   *  its own bindings in edit mode). */
  useEffect(() => {
    if (!(markdown && mode === 'preview')) return
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      if (target instanceof HTMLElement
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      const el = mdRef.current
      if (el === null) return
      if (event.ctrlKey && event.key === 'Home') {
        event.preventDefault()
        if (mdLines !== null) {
          const visible = Math.max(10, Math.ceil(el.clientHeight / MD_LINE_HEIGHT))
          lastWinStartRef.current = 0
          setWinStart(0)
          setLoadedEnd(gridCeil(Math.min(mdLines.length, visible * 2)))
        }
        el.scrollTop = 0
        return
      }
      if (event.ctrlKey && event.key === 'End') {
        event.preventDefault()
        if (mdLines !== null) {
          const visible = Math.max(10, Math.ceil(el.clientHeight / MD_LINE_HEIGHT))
          const newStart = gridFloor(Math.max(0, mdLines.length - visible * 2))
          lastWinStartRef.current = newStart
          setWinStart(newStart)
          setLoadedEnd(mdLines.length)
          requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
        } else {
          el.scrollTop = el.scrollHeight
        }
        return
      }
      if (event.key === 'PageUp') {
        event.preventDefault()
        el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight * 0.9)
        return
      }
      if (event.key === 'PageDown') {
        event.preventDefault()
        el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + el.clientHeight * 0.9)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [markdown, mode, mdLines])

  /** md/mermaid block split for the preview (mermaid fences lift out). Split
   *  only in preview mode: edit-mode keystrokes must not re-scan the source. */
  const mdBlocks = useMemo(
    () => (markdown && mode === 'preview' ? splitMermaidBlocks(mdText) : []),
    [markdown, mode, mdText],
  )
  const hasMermaid = useMemo(
    () => mdBlocks.some(block => block.kind === 'mermaid'),
    [mdBlocks],
  )
  const codeLabels = { copyLabel: t('copy'), copiedLabel: t('copied') }

  /**
   * Selection popup for the markdown preview: a mouse-up inside the preview
   * container anchors the floating "add to conversation" button above the
   * selection. Line numbers come from a best-effort reverse-search of the
   * selected text in the source ({@link linesOfSelection} — an ambiguous or
   * missing hit omits them). The button's own mousedown preventDefaults so
   * the selection survives until the click commits.
   */
  const handlePreviewMouseUp = (): void => {
    const sel = window.getSelection()
    if (sel === null || sel.isCollapsed || sel.anchorNode === null || sel.focusNode === null) {
      hidePopup()
      return
    }
    const host = mdRef.current
    if (host === null || !host.contains(sel.anchorNode) || !host.contains(sel.focusNode)) {
      hidePopup()
      return
    }
    const text = sel.toString()
    if (text.trim() === '') {
      hidePopup()
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const lines = linesOfSelection(mdText, text)
    setFileInfo(current => ({ total: mdText.length, selected: text.length }))
    showPopup(
      buildSelectionInsert(path, scope.cwd, lines ?? undefined, text),
      rect.left + rect.width / 2,
      rect.top,
    )
  }
  const editable = content !== undefined
  const saveLabel = saveState === 'saving' ? t('loading') : saveState === 'saved' ? t('saved') : saveState === 'failed' ? t('saveFailed') : ''
  // 底部信息栏：总字数 + 当前选中字数（编辑模式来自 CodeMirror 文档与选区，
  // markdown 预览模式来自渲染文本与窗口选区）。
  const [fileInfo, setFileInfo] = useState<{ total: number; selected: number }>({ total: 0, selected: 0 })
  // Per-feature sandbox escape hatch: the global side card setting (warned)
  // plus a per-surface temporary unlock. The unlock state starts at the
  // "default unsafe" pref so a preview can open straight into the red
  // unsandboxed state (still restorable from the status row). With the
  // sandbox OFF the preview iframe drops its sandbox attribute entirely —
  // the previewed page then runs on the GUI's own origin with full session
  // access.
  const [localUnlock, setLocalUnlock] = useState(() => props.store?.getPrefs().htmlViewerDefaultUnsafe === true)
  const htmlNoSandbox = props.store?.getPrefs().htmlViewerNoSandbox === true || localUnlock

  // Host-toolbar mode (the merged editor header renders the controls): skip
  // the own toolbar row, report the state after every relevant render (the
  // JSON key guards redundant calls), and register the commands on mount.
  const hostToolbar = props.toolbar === 'host'
  const lastToolbarRef = useRef('')
  useEffect(() => {
    if (!hostToolbar) return
    const state: EditorToolbarState = { modes: markdown || html, mode, dirty, editable, saveState }
    const key = JSON.stringify(state)
    if (lastToolbarRef.current === key) return
    lastToolbarRef.current = key
    props.onToolbarState?.(state)
  })
  useEffect(() => {
    if (!hostToolbar) return
    // `save` reads live refs only, and `setMode` is the stable state setter —
    // registering this render's closures is safe for the mount's lifetime.
    props.onToolbarControls?.({ setMode, save })
    return () => { props.onToolbarControls?.(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostToolbar])

  return (
    <>
      {!hostToolbar && (
      <div className={css.editorHeader}>
        {(markdown || html) && (
          <div className={css.editorModeToggle}>
            <button
              type="button"
              className={clsx(css.editorModeButton, mode === 'preview' && css.editorModeActive)}
              onClick={() => { setMode('preview') }}
            >
              {t('preview')}
            </button>
            <button
              type="button"
              className={clsx(css.editorModeButton, mode === 'edit' && css.editorModeActive)}
              onClick={() => { setMode('edit') }}
            >
              {t('edit')}
            </button>
          </div>
        )}
        {dirty && <span className={css.dirtyDot} title={t('unsaved')} />}
        {editable && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('save')}
            title={`${t('save')} (Ctrl/Cmd+S)`}
            onClick={save}
          >
            <IconCheckOutline16 />
          </button>
        )}
        {saveLabel !== '' && <span className={clsx(css.editorStatus, saveState === 'failed' && css.editorStatusError)}>{saveLabel}</span>}
      </div>
      )}
      {editable && (
        <>
          {truncated === true && mode === 'edit' && <div className={css.editorBanner}>{t('truncation')}</div>}
          <div
            className={clsx(css.editorCm, (markdown || html) && mode === 'preview' && css.editorCmHidden)}
            ref={hostRef}
          />
        </>
      )}
      {markdown && mode === 'preview' && (
        <div
          className={css.editorMd}
          ref={mdRef}
          onMouseUp={handlePreviewMouseUp}
          onScroll={handleMdScroll}
        >
          {/* The fence copy-button labels must come from this plugin's own
              dictionary: the DSH MarkdownText/CodeBlock are cordis-free and
              fall back to hardcoded Chinese otherwise (same pattern as the
              chat's AssistantMarkdown). Render-time t() keeps them following
              the active locale on live switches. Mermaid fences hand the
              whole document to the mermaid lazy chunk (single markdown
              parse; cross-fence references/footnotes stay intact); files
              without one render exactly as before. Huge files render as
              append-only segments — each its own MarkdownText block, so
              loaded content is never re-parsed. */}
          {mdLines === null
            ? (hasMermaid
              ? <LazyMermaidMarkdown text={mdText} codeLabels={codeLabels} />
              : <MarkdownText text={mdText} codeLabels={codeLabels} />)
            : mdSegments !== null && mdSegments.map((segment) => (
              <div
                key={segment.start}
                ref={(el) => {
                  if (el !== null) segRefs.current.set(segment.start, el)
                  else segRefs.current.delete(segment.start)
                }}
              >
                {hasMermaid
                  ? <LazyMermaidMarkdown text={segment.text} codeLabels={codeLabels} />
                  : <MarkdownText text={segment.text} codeLabels={codeLabels} />}
              </div>
            ))}
        </div>
      )}
      {html && mode === 'preview' && (
        <>
          <SandboxStatusBar
            sandboxed={!htmlNoSandbox}
            local={localUnlock}
            dangerCopy={t('htmlNoSandboxWarning')}
            onUnlock={() => { setLocalUnlock(true) }}
            onRestore={() => { setLocalUnlock(false) }}
          />
          {/* Route-src (never srcdoc — a srcdoc frame inherits the parent
              origin when unsandboxed; the route URL keeps the frame
              cross-origin by construction). The preview shows the SAVED
              file; the draft is only visible in edit mode. */}
          <iframe
            className={css.editorHtml}
            src={htmlUrl(scope, path)}
            sandbox={htmlNoSandbox ? undefined : HTML_IFRAME_SANDBOX}
            referrerPolicy="no-referrer"
            allow=""
            title={path}
          />
        </>
      )}
      {popup !== null && createPortal(
        <button
          type="button"
          className={css.selectionPopup}
          style={{ left: popup.left, top: popup.top }}
          // Keep the selection (and CodeMirror focus) alive until the click
          // commits — without this the popup unmounts before click lands.
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={commitPopup}
        >
          {t('addToConversation')}
        </button>,
        document.body,
      )}
      {/* 底部信息栏：文本文件的字数统计（总字数 + 当前选中字数）。
          html 预览是 iframe，不统计；其余（编辑模式任意文件 / code 与
          markdown 预览）都是文本视图。 */}
      {editable && !(html && mode === 'preview') && (
        <div className={css.editorInfoBar}>
          <span>{t('infoTotalChars', { n: (markdown && mode === 'preview' ? mdText.length : fileInfo.total).toLocaleString() })}</span>
          {fileInfo.selected > 0 && <span>{t('infoSelectedChars', { n: fileInfo.selected.toLocaleString() })}</span>}
        </div>
      )}
    </>
  )
}
