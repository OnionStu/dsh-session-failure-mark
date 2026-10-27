/**
 * dsh-session-failure-mark host half.
 *
 * Answers one question over HTTP for the browser half: how did this Session's
 * latest turn end? The answer decides whether the sidebar marks the Session
 * as failed.
 *
 * Why the mail-order read instead of a Session projection: projections only
 * carry a value once the Session has been driven in this process and its
 * projection cache row exists. The sessions that matter here are exactly the
 * cold ones — a GUI restarted after a crash or a connection error lists
 * Sessions that were never opened in the new process, so a projection would
 * report nothing for them. Reading the stored log covers both live and cold
 * Sessions with one code path.
 *
 * An unterminated latest turn (the process died mid-turn) has no `turn/end`
 * event in the raw log; it is reported as `interrupted`, the verdict the
 * session-query and resume paths give that log shape.
 *
 * Cost control: `stat` is metadata-only, so an unchanged Session is answered
 * from the in-memory cache after one cheap call. Only Sessions whose stored
 * artifact changed (new events appended) are opened and folded, and the fold
 * stops at the last `turn/end` event. Results survive a restart in
 * `$DSH_HOME/session-failure-mark/cache.json`, keyed by the persistence
 * revision so a stale row can never answer for a newer log.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const inject = ['webServer', 'sessionPersistence']

const API_PREFIX = '/api/session-failure-mark'
const CACHE_VERSION = 1
const BODY_LIMIT = 64 * 1024
const MAX_QUERY_IDS = 60
const READ_TIMEOUT_MS = 20_000
/**
 * Stored logs above this size are not folded: the persistence seam materializes
 * a whole log before slicing it, and a hundred-megabyte Session would spike the
 * host heap for one sidebar dot. Such a Session stays unmarked instead.
 */
const MAX_FOLD_BYTES = 12 * 1024 * 1024
const PERSIST_DEBOUNCE_MS = 1500

/** Turn-end kinds this plugin presents as a failed run (the operator's scope). */
const FAILURE_KINDS = new Set(['error', 'interrupted', 'max-tokens'])

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  let value = address.toLowerCase()
  if (value === '::1') return true
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length)
  const parts = value.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || isLoopbackAddress(hostname)
}

/**
 * Same trust fence as the first-party web routes: loopback socket, loopback
 * Host header, and browser same-origin markers. A bare local curl without any
 * browser signal is refused.
 */
function isTrustedBrowserRequest(req) {
  const site = req.headers['sec-fetch-site']
  if (site !== 'same-origin' && typeof req.headers.origin !== 'string') return false
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (site === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw httpError(413, 'body-too-large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'invalid-json')
  }
}

/** Reject instead of hanging the request when a stored-log read stalls. */
function withTimeout(promise, milliseconds, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/**
 * Fold one Session's stored log into the fact the browser renders.
 *
 * An unterminated last turn is the crash case: the agent loop appends
 * `turn/end` only while it is alive, so a process killed mid-turn leaves a
 * `turn/start` with no closer. The session-query and resume paths synthesize
 * that closer as `interrupted`; a raw-log reader must reach the same verdict
 * from the missing closer itself.
 *
 * @param events - the Session's stored events in seq order.
 * @returns the latest turn's outcome.
 */
export function outcomeOf(events) {
  let lastStart
  let lastEnd
  for (const event of events) {
    if (event?.type === 'turn/start') lastStart = event
    else if (event?.type === 'turn/end') lastEnd = event
  }
  if (lastStart !== undefined && (lastEnd === undefined || lastStart.seq > lastEnd.seq)) {
    return { state: 'interrupted', failed: true, at: lastStart.time }
  }
  if (lastEnd === undefined) return { state: 'empty' }
  const reason = lastEnd?.data?.reason
  const kind = typeof reason?.kind === 'string' ? reason.kind : 'unknown'
  const at = typeof lastEnd.time === 'number' ? lastEnd.time : undefined
  if (kind !== 'error') return { state: kind, failed: FAILURE_KINDS.has(kind), at }
  const failure = reason?.error ?? {}
  return {
    state: 'error',
    failed: true,
    at,
    message: typeof failure.message === 'string' ? failure.message : undefined,
    code: typeof failure.code === 'string' ? failure.code : undefined,
  }
}

export function apply(ctx) {
  const cachePath = path.join(dshHome(), 'session-failure-mark', 'cache.json')
  /** sessionId -> { revision, ...outcome, checkedAt } */
  const cache = new Map()
  let persistTimer = null

  function loadCache() {
    let text
    try {
      text = readFileSync(cachePath, 'utf8')
    } catch {
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (parsed?.version !== CACHE_VERSION || typeof parsed.entries !== 'object' || parsed.entries === null) return
    for (const [id, entry] of Object.entries(parsed.entries)) {
      if (typeof entry?.revision === 'string' && typeof entry?.state === 'string') cache.set(id, entry)
    }
  }

  function persistNow() {
    persistTimer = null
    const entries = {}
    for (const [id, entry] of cache) entries[id] = entry
    const body = JSON.stringify({ version: CACHE_VERSION, entries })
    try {
      mkdirSync(path.dirname(cachePath), { recursive: true })
      const temporary = `${cachePath}.tmp`
      writeFileSync(temporary, body, 'utf8')
      renameSync(temporary, cachePath)
    } catch {
      // A cache write failure costs a refold after restart, never the feature.
    }
  }

  function schedulePersist() {
    if (persistTimer !== null) return
    persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS)
    persistTimer.unref?.()
  }

  /** Read one stored log and report how its latest turn ended. */
  async function foldStoredSession(sessionId) {
    const handle = await ctx.sessionPersistence.open(sessionId, 'read')
    try {
      const { events } = await handle.read()
      return outcomeOf(events)
    } finally {
      await Promise.resolve(handle.close()).catch(() => {})
    }
  }

  /** Answer one Session, reusing the cache while its stored artifact is unchanged. */
  async function resolveSession(sessionId) {
    let snapshot
    try {
      snapshot = await ctx.sessionPersistence.stat(sessionId)
    } catch (error) {
      return { sessionId, state: 'unavailable', failed: false, error: errorText(error) }
    }
    if (snapshot === undefined) return { sessionId, state: 'missing', failed: false }
    const revision = `${String(snapshot.revision)}|${String(snapshot.sizeBytes ?? '')}|${String(snapshot.eventCount ?? '')}`
    const cached = cache.get(sessionId)
    if (cached !== undefined && cached.revision === revision) return { ...cached, sessionId }
    if (typeof snapshot.sizeBytes === 'number' && snapshot.sizeBytes > MAX_FOLD_BYTES) {
      const skipped = { state: 'too-large', failed: false, revision, checkedAt: Date.now() }
      cache.set(sessionId, skipped)
      schedulePersist()
      return { ...skipped, sessionId }
    }
    let outcome
    try {
      outcome = await withTimeout(foldStoredSession(sessionId), READ_TIMEOUT_MS, `read ${sessionId}`)
    } catch (error) {
      // Live Sessions materialize on their own schedule; a failed read stays
      // unanswered so the next poll retries instead of caching a wrong verdict.
      return { sessionId, state: 'unavailable', failed: false, error: errorText(error) }
    }
    const entry = { ...outcome, failed: outcome.failed === true, revision, checkedAt: Date.now() }
    cache.set(sessionId, entry)
    schedulePersist()
    return { ...entry, sessionId }
  }

  const stateRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/state`,
    handler: (req, res) => {
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isTrustedBrowserRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
      const items = []
      for (const [sessionId, entry] of cache) {
        items.push({
          sessionId,
          state: entry.state,
          failed: entry.failed === true,
          at: entry.at,
          message: entry.message,
          code: entry.code,
          checkedAt: entry.checkedAt,
        })
      }
      writeJson(res, 200, { ok: true, items })
    },
  }

  const queryRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/query`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isTrustedBrowserRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        return writeJson(res, typeof error?.status === 'number' ? error.status : 400, { ok: false, error: errorText(error) })
      }
      const requested = Array.isArray(body?.ids) ? body.ids : []
      const ids = []
      const seen = new Set()
      for (const value of requested) {
        if (typeof value !== 'string' || value === '' || seen.has(value)) continue
        seen.add(value)
        ids.push(value)
        if (ids.length >= MAX_QUERY_IDS) break
      }
      const items = []
      for (const sessionId of ids) {
        items.push(await resolveSession(sessionId))
        // Fold one stored log per macrotask: keeps the host responsive while a
        // cold list fills in.
        await new Promise((resolve) => setImmediate(resolve))
      }
      writeJson(res, 200, { ok: true, items })
    },
  }

  ctx.effect(() => {
    loadCache()
    const disposers = [stateRoute, queryRoute].map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
      if (persistTimer !== null) {
        clearTimeout(persistTimer)
        persistTimer = null
        persistNow()
      }
    }
  }, 'session-failure-mark: routes')
}

function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

export default { inject, apply }
