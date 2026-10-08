// VPlay SDK bridge — the ONLY place the game talks to vplay.gg.
// Protocol: postMessage request/response over an exact-origin allowlist.
// vplay.gg owns money, ownership and saves; the game only asks.

export type VPlayMode = 'vplay' | 'standalone'
export interface VPlayPlayer { signedIn: boolean; displayName: string | null; member: boolean }
export interface VPlayItem { id: string; priceVc: number; owned: boolean }
export interface VPlayInit {
  mode: VPlayMode
  player: VPlayPlayer
  vcoins: number            // display only, never trusted for logic
  items: VPlayItem[]        // prices come from vplay.gg, NOT from the game
  entitlements: string[]    // item ids this player owns on vplay.gg
  save: unknown | null      // cloud save, null if none / guest
}
export type PurchaseResult =
  | { status: 'purchased'; entitlements: string[]; vcoins: number }
  | { status: 'cancelled' | 'needs_signin' | 'insufficient' | 'unavailable' | 'error'; message?: string }

// Release allowlist: vplay.gg ONLY. Localhost (any port, incl. :3000) is
// accepted solely in dev builds via the DEV branch in isAllowedOrigin below.
const ALLOWED_ORIGINS = ['https://vplay.gg', 'https://www.vplay.gg']
const INIT_TIMEOUT_MS = 6000
const PURCHASE_TIMEOUT_MS = 180000

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true
  // Dev/test rigs only: the mock host (vplay-host-mock.html) can run on any
  // localhost port. Release builds keep the strict allowlist above.
  if (import.meta.env.DEV && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true
  return false
}

type EventName = 'pause' | 'resume' | 'mute' | 'unmute' | 'entitlements' | 'vcoins'

function hostOriginFromReferrer(): string | null {
  try {
    const ref = document.referrer
    if (!ref) return null
    const origin = new URL(ref).origin
    return isAllowedOrigin(origin) ? origin : null
  } catch {
    return null
  }
}

function createApi() {
  let mode: VPlayMode = 'standalone'
  let hostOrigin: string | null = null
  let ready = false
  let reqSeq = 0
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>()
  const listeners = new Map<EventName, Set<(data?: unknown) => void>>()

  const inIframe = typeof window !== 'undefined' && window.parent !== window

  function send(method: string, params: Record<string, unknown>, waitForReply: boolean): Promise<unknown> {
    if (mode !== 'vplay' || !hostOrigin) return Promise.resolve(null)
    const origin = hostOrigin // captured: narrowing doesn't survive into closures
    const id = `r${++reqSeq}${Date.now()}`
    const msg = { __vplay: 1, kind: 'req', id, method, params }
    if (!waitForReply) {
      window.parent.postMessage(msg, origin)
      return Promise.resolve(null)
    }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id)
        reject(new Error(`vplay timeout: ${method}`))
      }, method === 'purchase' ? PURCHASE_TIMEOUT_MS : INIT_TIMEOUT_MS)
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      window.parent.postMessage(msg, origin)
    })
  }

  function onMessage(event: MessageEvent): void {
    // Security: only the allowed parent origin, only our protocol envelope
    if (event.source !== window.parent) return
    if (!hostOrigin || event.origin !== hostOrigin) return
    const data = event.data as Record<string, unknown> | null
    if (!data || data.__vplay !== 1) return

    if (data.kind === 'res') {
      const id = data.id as string
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      window.clearTimeout(p.timer)
      if (data.ok) p.resolve(data.result)
      else p.reject(new Error(((data.error as { message?: string }) || {}).message || 'vplay error'))
    } else if (data.kind === 'evt') {
      const name = data.name as EventName
      const set = listeners.get(name)
      if (set) for (const cb of [...set]) cb(data.data)
    }
  }

  const api = {
    async init(opts: { gameId: 'neon-harbor'; sdkVersion: 1 }): Promise<VPlayInit> {
      const fallback: VPlayInit = {
        mode: 'standalone',
        player: { signedIn: false, displayName: null, member: false },
        vcoins: 0,
        items: [],
        entitlements: [],
        save: null,
      }
      hostOrigin = hostOriginFromReferrer()
      if (inIframe && hostOrigin) {
        window.addEventListener('message', onMessage)
        mode = 'vplay'
        try {
          const result = (await send('init', opts, true)) as Omit<VPlayInit, 'mode'> | null
          if (result) {
            ready = true
            return { mode: 'vplay', ...result }
          }
        } catch {
          /* host didn't answer in time — fall back to standalone, never throw */
        }
        mode = 'standalone'
        hostOrigin = null
      }
      return fallback
    },

    loading(progress: number): void {
      if (!ready) return
      void send('loading', { progress: Math.max(0, Math.min(1, progress)) }, false)
    },
    gameplayStart(): void {
      if (!ready) return
      void send('gameplayStart', {}, false)
    },
    gameplayStop(): void {
      if (!ready) return
      void send('gameplayStop', {}, false)
    },

    async purchase(itemId: string): Promise<PurchaseResult> {
      if (mode !== 'vplay' || !ready) return { status: 'unavailable' }
      try {
        const result = (await send('purchase', { itemId }, true)) as PurchaseResult
        return result
      } catch (e) {
        return { status: 'error', message: e instanceof Error ? e.message : 'purchase failed' }
      }
    },

    async entitlements(): Promise<string[]> {
      if (mode !== 'vplay' || !ready) return []
      try {
        const result = (await send('entitlements', {}, true)) as { entitlements?: string[] } | string[] | null
        if (Array.isArray(result)) return result
        return result?.entitlements ?? []
      } catch {
        return []
      }
    },

    saveCloud(data: unknown): void {
      if (!ready) return
      let json: string
      try {
        json = JSON.stringify(data ?? null)
      } catch {
        return
      }
      if (json.length > 64 * 1024) return
      void send('saveCloud', { data: JSON.parse(json) }, false)
    },

    milestone(id: string): void {
      if (!ready) return
      void send('milestone', { id }, false)
    },

    openOnVplay(): void {
      window.open('https://vplay.gg/games/neon-harbor', '_blank', 'noopener')
    },

    on(event: EventName, cb: (data?: unknown) => void): () => void {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(cb)
      return () => {
        set.delete(cb)
      }
    },
  }
  return api
}

export const VPlay = createApi()
