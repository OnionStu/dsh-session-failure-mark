/**
 * dsh-session-failure-mark browser half.
 *
 * Marks the sidebar rows of Sessions whose latest turn failed. Three surfaces,
 * all driven by one small state map fetched from the host half:
 *
 *   1. the row's leading 16px cell carries a red dot (registered into the
 *      `sidebar.session.row.leading` seat, so the shell owns placement);
 *   2. the row's hover card carries a failure line
 *      (`sidebar.session.row.hover`);
 *   3. the row title turns red;
 *   4. a footer entry ("N 个会话运行失败") expands collapsed groups and brings
 *      a failed row into view, because the sidebar only renders the first few
 *      rows of each workspace. The title belongs to the shell's own row
 *      component, which exposes no seat for its styling, so the marker is a
 *      DOM attribute this half maintains on the row element (the shell already
 *      stamps `data-row-key="session:<id>"` on every row) plus one stylesheet
 *      that colours the title through the attribute.
 *
 * Nothing here activates or retains a Session: the host half reads stored
 * logs, and this half only asks it about the rows currently listed.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-failure-mark',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const inject = ['sessions', 'workspaces', 'slots']

    const API_PREFIX = '/api/session-failure-mark'
    const STYLE_TAG_ID = 'dsh-session-failure-mark-styles'
    const ROW_SELECTOR = '[data-row-key^="session:"]'
    const ROW_ATTRIBUTE = 'data-dsm-failed'
    /** Rows asked about in one round trip; the host folds stored logs behind this. */
    const QUERY_BATCH = 4
    /** Newest rows worth asking about; older rows are out of sight in the list. */
    const VISIBLE_LIMIT = 48
    const POLL_MS = 12_000
    const MARK_INTERVAL_MS = 1_500

    const zh = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')

    const LABELS = zh
      ? {
          title: '本轮运行失败',
          interrupted: '本轮运行中断',
          maxTokens: '已达到输出 token 上限',
          aria: '本轮运行失败',
        }
      : {
          title: 'This turn failed',
          interrupted: 'This turn was interrupted',
          maxTokens: 'Output token limit reached',
          aria: 'This turn failed',
        }

    const CSS = `
[data-row-key^="session:"][${ROW_ATTRIBUTE}="true"] [class*="_title"] {
  color: var(--dsw-alias-state-error-primary, #e5484d) !important;
}
.dsfm-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
}
.dsfm-dot::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-error-primary, #e5484d);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 18%, transparent);
}
.dsfm-hover {
  display: flex;
  grid-template-columns: 10px minmax(0, 1fr);
  align-items: start;
  gap: 6px;
  font-size: 12px;
  line-height: 16px;
}
.dsfm-hover-title {
  color: var(--dsw-alias-state-error-primary, #e5484d);
  font-weight: 600;
}
.dsfm-hover-detail {
  color: var(--dsw-alias-label-secondary, inherit);
  overflow-wrap: anywhere;
}
.dsfm-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 8px 12px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
  text-align: left;
  cursor: pointer;
}
.dsfm-entry:hover {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 12%, transparent);
}
.dsfm-entry--narrow {
  justify-content: center;
  padding: 8px 0;
}
.dsfm-entry-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-error-primary, #e5484d);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 20%, transparent);
}
.dsfm-entry-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-row-key^="session:"][data-dsm-flash="true"] {
  outline: 2px solid var(--dsw-alias-state-error-primary, #e5484d);
  outline-offset: -2px;
  border-radius: 6px;
}
`

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_TAG_ID) !== null) return
      const tag = document.createElement('style')
      tag.id = STYLE_TAG_ID
      tag.dataset.pluginCss = STYLE_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ----- shared state: one entry per Session the host has answered for ----- */

    /** sessionId -> { failed, state, message?, code?, at? } */
    let state = new Map()
    let snapshot = state
    const listeners = new Set()

    function publish() {
      snapshot = new Map(state)
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // A listener that throws must not break the other seats.
        }
      }
      scheduleMark()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    function useFailureEntries() {
      return React.useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
    }

    function headline(entry) {
      if (entry.state === 'interrupted') return LABELS.interrupted
      if (entry.state === 'max-tokens') return LABELS.maxTokens
      return LABELS.title
    }

    function detail(entry) {
      const parts = []
      if (typeof entry.message === 'string' && entry.message !== '') parts.push(entry.message)
      if (typeof entry.code === 'string' && entry.code !== '' && entry.code !== 'UNKNOWN') parts.push(entry.code)
      return parts.join(' · ')
    }

    /* ----- host reads ----- */

    async function queryHost(ids) {
      const response = await fetch(API_PREFIX + '/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`session-failure-mark: HTTP ${response.status}`)
      const payload = await response.json()
      if (payload?.ok !== true || !Array.isArray(payload.items)) throw new Error('session-failure-mark: malformed response')
      return payload.items
    }

    /* ----- row attribute maintenance (title colour) ----- */

    let markTimer = null
    let observer = null

    function scheduleMark() {
      if (markTimer !== null) return
      markTimer = setTimeout(() => {
        markTimer = null
        markRows()
      }, 60)
      markTimer.unref?.()
    }

    function markRows() {
      if (typeof document === 'undefined') return
      for (const row of document.querySelectorAll(ROW_SELECTOR)) {
        const key = row.getAttribute('data-row-key') ?? ''
        const sessionId = key.slice('session:'.length)
        const entry = state.get(sessionId)
        if (entry?.failed === true) row.setAttribute(ROW_ATTRIBUTE, 'true')
        else row.removeAttribute(ROW_ATTRIBUTE)
      }
    }

    /* ----- scheduling ----- */

    function listSnapshot(ctx) {
      try {
        return ctx.sessions.list.getSnapshot()
      } catch {
        return undefined
      }
    }

    /**
     * Sessions the operator archived. An archived row is outside the default
     * sidebar, so counting it in the footer would advertise a row that the
     * reveal action cannot bring into view.
     */
    function archivedSet(ctx) {
      try {
        const snapshot = ctx.workspaces?.list?.getSnapshot?.()
        return new Set(snapshot?.archivedSessionIds ?? [])
      } catch {
        return new Set()
      }
    }

    /** Newest visible rows the sidebar can actually show. */
    function listedSessions(ctx) {
      const snapshot = listSnapshot(ctx)
      if (snapshot === undefined) return []
      const archived = archivedSet(ctx)
      const visible = []
      for (const id of snapshot.ids ?? []) {
        const row = snapshot.byId?.[id]
        if (row === undefined) continue
        if (row.blank || row.origin === 'subagent') continue
        // A running Session has no settled outcome yet; the shell already shows
        // its activity dot, and a stale red mark would contradict it.
        if (row.running) continue
        if (archived.has(id)) continue
        visible.push(row)
      }
      visible.sort((left, right) => right.updatedAt - left.updatedAt)
      return visible.slice(0, VISIBLE_LIMIT)
    }

    /** Drop marks for Sessions that started a new turn; their verdict is stale. */
    function dropRunning(ctx) {
      const snapshot = listSnapshot(ctx)
      if (snapshot === undefined) return
      const archived = archivedSet(ctx)
      let changed = false
      for (const id of snapshot.ids ?? []) {
        const row = snapshot.byId?.[id]
        if (row?.running !== true && !archived.has(id)) continue
        if (state.delete(id)) changed = true
      }
      if (changed) publish()
    }

    function apply(ctx) {
      ensureStyles()

      let disposed = false
      let refreshing = false
      let lastRefreshStart = 0

      async function refresh() {
        if (disposed || refreshing) return
        refreshing = true
        lastRefreshStart = Date.now()
        try {
          dropRunning(ctx)
          const items = listedSessions(ctx)
          const ids = items.map((row) => row.id)
          for (let index = 0; index < ids.length; index += QUERY_BATCH) {
            if (disposed) return
            const batch = ids.slice(index, index + QUERY_BATCH)
            let answers
            try {
              answers = await queryHost(batch)
            } catch {
              return
            }
            if (disposed) return
            let changed = false
            for (const answer of answers) {
              if (typeof answer?.sessionId !== 'string') continue
              const next = {
                failed: answer.failed === true,
                state: typeof answer.state === 'string' ? answer.state : 'unknown',
                message: typeof answer.message === 'string' ? answer.message : undefined,
                code: typeof answer.code === 'string' ? answer.code : undefined,
                at: typeof answer.at === 'number' ? answer.at : undefined,
              }
              const current = state.get(answer.sessionId)
              if (current === undefined
                || current.failed !== next.failed
                || current.state !== next.state
                || current.message !== next.message
                || current.code !== next.code
                || current.at !== next.at) {
                state.set(answer.sessionId, next)
                changed = true
              }
            }
            if (changed) publish()
          }
          scheduleMark()
        } finally {
          refreshing = false
        }
      }

      const pollTimer = setInterval(() => {
        // A hidden tab needs no answers; coming back refreshes immediately.
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        if (Date.now() - lastRefreshStart < POLL_MS - 500) return
        void refresh()
      }, POLL_MS)
      pollTimer.unref?.()

      const onVisibility = () => {
        if (document.visibilityState === 'visible') void refresh()
      }
      document.addEventListener('visibilitychange', onVisibility)

      const markTicker = setInterval(markRows, MARK_INTERVAL_MS)
      markTicker.unref?.()

      observer = new MutationObserver(() => scheduleMark())
      observer.observe(document.body, { childList: true, subtree: true })

      // The list store changes on every host list pull and live stream frame;
      // coalesce those into at most one refresh per second.
      let listDebounce = null
      let unsubscribeList = null
      try {
        unsubscribeList = ctx.sessions.list.subscribe(() => {
          if (disposed || listDebounce !== null) return
          listDebounce = setTimeout(() => {
            listDebounce = null
            void refresh()
          }, 1_000)
          listDebounce.unref?.()
        })
      } catch {
        unsubscribeList = null
      }

      const firstPass = setTimeout(() => void refresh(), 800)

      const slots = ctx.get('slots')
      const disposers = []
      if (slots !== undefined) {
        disposers.push(slots.inject('sidebar.session.row.leading', () => slots.register({
          name: 'sidebar.session.row.leading',
          id: 'session-failure-mark',
          order: 5,
        }, SessionFailureMark)))
        disposers.push(slots.inject('sidebar.session.row.hover', () => slots.register({
          name: 'sidebar.session.row.hover',
          id: 'session-failure-mark',
          order: 20,
        }, SessionFailureHover)))
        disposers.push(slots.inject('sidebar.footer.action', () => slots.register({
          name: 'sidebar.footer.action',
          id: 'session-failure-mark',
          order: -7,
          label: () => (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? '运行失败的会话' : 'Failed sessions'),
        }, SidebarFailureEntry)))
      }

      ctx.effect(() => () => {
        disposed = true
        clearTimeout(firstPass)
        clearInterval(pollTimer)
        clearInterval(markTicker)
        if (markTimer !== null) clearTimeout(markTimer)
        document.removeEventListener('visibilitychange', onVisibility)
        if (listDebounce !== null) clearTimeout(listDebounce)
        if (typeof unsubscribeList === 'function') unsubscribeList()
        observer?.disconnect()
        observer = null
        for (const dispose of disposers.splice(0)) dispose()
        const tag = document.getElementById(STYLE_TAG_ID)
        if (tag !== null) tag.remove()
        for (const row of document.querySelectorAll(ROW_SELECTOR)) row.removeAttribute(ROW_ATTRIBUTE)
        listeners.clear()
      }, 'session-failure-mark: mount')
    }

    /* ----- reveal a failed row that a collapsed group hides ----- */

    let revealIndex = 0

    function isExpandLabel(text) {
      const trimmed = (text ?? '').trim()
      return /^展开其余\s*\d+\s*个会话$/.test(trimmed) || /^Show\s+\d+\s+more sessions$/i.test(trimmed)
    }

    /**
     * Expand the workspace browser's collapsed groups one at a time. A click
     * re-renders the list, which replaces the remaining buttons, so each round
     * re-queries the DOM instead of iterating a stale node list; the walk stops
     * when no expand button is left (or after a safety cap).
     */
    function expandCollapsedGroups(done, attempts = 0) {
      if (typeof document === 'undefined' || attempts > 40) {
        done()
        return
      }
      let next
      for (const button of document.querySelectorAll('button')) {
        if (isExpandLabel(button.textContent)) {
          next = button
          break
        }
      }
      if (next === undefined) {
        done()
        return
      }
      next.click()
      setTimeout(() => expandCollapsedGroups(done, attempts + 1), 90)
    }

    /**
     * Expand every collapsed group, then bring one failed row into view. Repeated
     * clicks walk the failed rows in turn, so several failures stay reachable
     * from the one footer entry.
     */
    function revealFailedRow(ids) {
      expandCollapsedGroups(() => {
        setTimeout(() => {
          const rows = []
          for (const id of ids) {
            const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id
            const row = document.querySelector(`[data-row-key="session:${escaped}"]`)
            if (row !== null) rows.push(row)
          }
          if (rows.length === 0) return
          const target = rows[revealIndex % rows.length]
          revealIndex += 1
          target.scrollIntoView({ block: 'center', behavior: 'smooth' })
          target.setAttribute('data-dsm-flash', 'true')
          setTimeout(() => target.removeAttribute('data-dsm-flash'), 2_400)
        }, 260)
      })
    }

    /* ----- seats ----- */

    function SidebarFailureEntry(props) {
      const entries = useFailureEntries()
      const ids = []
      for (const [sessionId, entry] of entries) {
        if (entry?.failed === true) ids.push(sessionId)
      }
      if (ids.length === 0) return null
      const wide = props?.wide !== false
      const label = (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? `${ids.length} 个会话运行失败` : `${ids.length} failed session${ids.length === 1 ? '' : 's'}`)
      return React.createElement('button', {
        type: 'button',
        className: wide ? 'dsfm-entry' : 'dsfm-entry dsfm-entry--narrow',
        'data-dsm-part': 'sidebar-entry',
        'aria-label': label,
        title: label,
        onClick: () => revealFailedRow(ids),
      },
      React.createElement('span', { className: 'dsfm-entry-dot', 'aria-hidden': 'true' }),
      wide ? React.createElement('span', { className: 'dsfm-entry-label' }, label) : null)
    }

    function SessionFailureMark({ sessionId }) {
      const entries = useFailureEntries()
      const entry = entries.get(sessionId)
      if (entry?.failed !== true) return null
      const text = [headline(entry), detail(entry)].filter(Boolean).join(' · ')
      return React.createElement('span', {
        className: 'dsfm-dot',
        title: text,
        role: 'img',
        'aria-label': text,
        onClick: (event) => {
          event.stopPropagation()
        },
      })
    }

    function SessionFailureHover({ sessionId }) {
      const entries = useFailureEntries()
      const entry = entries.get(sessionId)
      if (entry?.failed !== true) return null
      const extra = detail(entry)
      return React.createElement(
        'div',
        { className: 'dsfm-hover' },
        React.createElement('span', { className: 'dsfm-hover-title' }, headline(entry)),
        extra === '' ? null : React.createElement('span', { className: 'dsfm-hover-detail' }, extra),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
