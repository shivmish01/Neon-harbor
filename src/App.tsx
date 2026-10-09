// ============================================================
// NEON HARBOR — React shell: boot screen, main menu (over the
// live 3D city), HUD with police instructions, shop, vplay.gg
// integration (VCoins, entitlements, cloud save, milestones).
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { GameEngine, type HudState } from './game/engine'
import { loadGameAssets, type GameAssets } from './game/assets'
import {
  SKINS, THEMES, HARBOR_PASS_ID, HARBOR_PASS_ITEMS, GAME_VERSION, GAME_TITLE,
  ACHIEVEMENTS, DISTRICTS, UPGRADES,
  type Skin, type Theme, type UpgradeId,
} from './game/content'
import { loadSave, persistSave, defaultSave, type SaveData } from './game/save'
import { VPlay, type VPlayInit, type PurchaseResult } from './vplay/sdk'
import { BUILD_HASH, BUILD_TIME } from './gen-build'
import HowToPlay from './components/HowToPlay'

type Screen = 'boot' | 'menu' | 'game'
type Overlay = null | 'shop' | 'jobs' | 'pause' | 'help' | 'progress' | 'map'

interface Toast {
  id: number
  msg: string
  kind: 'info' | 'cash' | 'warn' | 'good'
}

let toastId = 0

// Photo mode color grades (CSS filters applied to the 3D canvas)
const PHOTO_FILTERS = [
  { name: 'Normal', css: 'none' },
  { name: 'Golden', css: 'sepia(0.35) saturate(1.4) contrast(1.05)' },
  { name: 'Noir', css: 'grayscale(1) contrast(1.25) brightness(1.05)' },
  { name: 'Vapor', css: 'saturate(1.8) hue-rotate(25deg) contrast(1.1)' },
  { name: 'Cyber', css: 'saturate(1.5) hue-rotate(180deg) contrast(1.15)' },
]

export default function App() {
  const [screen, setScreen] = useState<Screen>('boot')
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [shopTab, setShopTab] = useState<'skins' | 'themes' | 'upgrades'>('skins')
  const [progressTab, setProgressTab] = useState<'trophies' | 'districts'>('trophies')
  const [tutorialHidden, setTutorialHidden] = useState(false)
  // Night Shift card: expanded on desktop, collapsed one-liner on touch
  const [shiftOpen, setShiftOpen] = useState(() => !window.matchMedia?.('(pointer: coarse)').matches)
  // First-run tap-through onboarding overlay (separate localStorage flag —
  // never touches the save format). Shown once before the FIRST NIGHT steps.
  const [onboardStep, setOnboardStep] = useState<number | null>(null)
  const ONBOARD_KEY = 'nh-onboard-v1'
  const skipOnboard = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('skipOnboard')
  const [photoMode, setPhotoMode] = useState(false)
  const [photoFilter, setPhotoFilter] = useState(0)
  const [save, setSave] = useState<SaveData>(() => loadSave())
  const [hud, setHud] = useState<HudState | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [bustedFlash, setBustedFlash] = useState(false)
  const [wreckFlash, setWreckFlash] = useState(false)
  // Mission-complete result banner — carries the 📷 photo button on mobile
  const [winBanner, setWinBanner] = useState<{ name: string; reward: number } | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  // Opening splash: Vary Gaming "PRESENTS" → vplay.gg "EXCLUSIVE" → title screen.
  // 0 = Vary Gaming, 1 = vplay.gg, 2 = splash finished. Skipped by ?autostart
  // (automated tests) and dismissible with a click/tap.
  const [splashStep, setSplashStep] = useState(0)
  // vplay.gg integration: mode/player/VCoin balance/premium entitlements.
  // vplay.gg owns money + ownership — the game only asks via the SDK.
  const [vplay, setVplay] = useState<VPlayInit | null>(null)
  const [vcBalance, setVcBalance] = useState(0)
  const [entitlements, setEntitlements] = useState<string[]>([])
  const [hostPaused, setHostPaused] = useState(false)
  const entitlementsRef = useRef<string[]>([])
  entitlementsRef.current = entitlements
  const vplayRef = useRef<VPlayInit | null>(null)
  vplayRef.current = vplay
  const lastCloudSaveRef = useRef(0)
  const pausedByHiddenRef = useRef(false)
  const lastKnownRef = useRef<{ ach: string[]; districts: string[] }>({ ach: [], districts: [] })
  // Mobile/tablet players get on-screen drive controls instead of keyboard hints.
  // ?forcetouch forces the touch path on desktop — used to preview the mobile FTUE.
  const [isTouch] = useState(
    () =>
      typeof window !== 'undefined' &&
      (window.matchMedia('(pointer: coarse)').matches ||
        'ontouchstart' in window ||
        new URLSearchParams(window.location.search).has('forcetouch')),
  )
  // Short landscape phones (≤440px tall) run the compact HUD — matches the
  // CSS media query. Used for content triage (what renders at all, not just
  // how big it is).
  const compactHud =
    isTouch && typeof window !== 'undefined' && window.matchMedia('(max-height: 440px)').matches
  // Mobile plays in landscape. We never ask the player to rotate: Android
  // Chrome gets a real orientation lock from the entry tap, and everything
  // else (iOS Safari…) gets the root div CSS-rotated into landscape below.
  const [isPortrait, setIsPortrait] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(orientation: portrait)').matches,
  )
  useEffect(() => {
    if (!isTouch) return
    const mq = window.matchMedia('(orientation: portrait)')
    const update = () => {
      setIsPortrait(mq.matches)
      // the rotated root changes the canvas box without a window resize —
      // nudge the engine so it re-sizes to what the player now sees
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    }
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [isTouch])

  // ---------- mobile FTUE logic: onboarding advances by DOING ----------
  // (drive, swipe, boost) — not by reading. A fallback SKIP never traps anyone.
  const [obFallback, setObFallback] = useState(false)
  useEffect(() => {
    setObFallback(false)
    if (onboardStep === null || onboardStep < 1) return
    const gated = isTouch ? onboardStep <= 4 : onboardStep <= 2
    if (!gated) return
    const t = setTimeout(() => setObFallback(true), onboardStep === 4 ? 16000 : 11000)
    return () => clearTimeout(t)
  }, [onboardStep, isTouch])
  // Auto-advance guard: schedule each step's "done → next" exactly once.
  const obAdvRef = useRef(false)
  useEffect(() => {
    obAdvRef.current = false
  }, [onboardStep])
  // Touch FTUE action gates: car moving (step 1), nitro fired (step 3),
  // reached the garage beam (step 4) → flash ✓, then move on.
  // NOTE: no cleanup on the timeout — hud updates re-run this effect every
  // frame and a cleanup would cancel the scheduled advance. obAdvRef already
  // guarantees it schedules exactly once per step.
  useEffect(() => {
    if (!isTouch || onboardStep === null || obAdvRef.current) return
    const done =
      (onboardStep === 1 && (hud?.speedKmh ?? 0) > 8) ||
      (onboardStep === 3 && !!hud && (hud.boosting || hud.boost < 95)) ||
      (onboardStep === 4 && !!hud?.nearGarage)
    if (!done) return
    obAdvRef.current = true
    setTimeout(() => setOnboardStep(onboardStep + 1), 950)
  }, [isTouch, onboardStep, hud])
  // Step 2 (touch): steering is a horizontal swipe — detect a real swipe
  // anywhere on screen and count it as "user did it".
  useEffect(() => {
    if (!isTouch || onboardStep !== 2) return
    let startX: number | null = null
    const ts = (e: TouchEvent) => {
      startX = e.touches[0]?.clientX ?? null
    }
    const tm = (e: TouchEvent) => {
      if (startX === null || obAdvRef.current) return
      const dx = (e.touches[0]?.clientX ?? startX) - startX
      if (Math.abs(dx) > 50) {
        obAdvRef.current = true
        setTimeout(() => setOnboardStep(3), 950)
      }
    }
    window.addEventListener('touchstart', ts, { passive: true })
    window.addEventListener('touchmove', tm, { passive: true })
    return () => {
      window.removeEventListener('touchstart', ts)
      window.removeEventListener('touchmove', tm)
    }
  }, [isTouch, onboardStep])

  // Splash sequence timing: each card holds ~2.2s (1.3s on vplay.gg);
  // ?autostart (dev builds only) skips straight into the game
  useEffect(() => {
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('autostart')) {
      setSplashStep(2)
      return
    }
    if (splashStep >= 2) return
    // vplay.gg asks for a fast boot — keep the whole splash under 3s there
    const stepMs = vplay?.mode === 'vplay' ? 1300 : 2200
    const t = setTimeout(() => setSplashStep((s) => s + 1), stepMs)
    return () => clearTimeout(t)
  }, [splashStep, vplay])

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const minimapRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<GameEngine | null>(null)
  const assetsRef = useRef<GameAssets | null>(null)
  const enterGameRef = useRef<(() => void) | null>(null)
  const [assetsReady, setAssetsReady] = useState(false)
  const [loadPct, setLoadPct] = useState(0)
  const saveRef = useRef(save)
  saveRef.current = save
  const screenRef = useRef(screen)
  screenRef.current = screen
  const overlayRef = useRef(overlay)
  overlayRef.current = overlay

  const pushToast = useCallback((msg: string, kind: Toast['kind']) => {
    const id = ++toastId
    setToasts((t) => [...t.slice(-3), { id, msg: isTouch ? sanitizeForTouch(msg) : msg, kind }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
  }, [isTouch])

  // ---- vplay.gg helpers ----
  /** One-time milestones: each id is reported to vplay.gg at most once per save. */
  const reportMilestone = useCallback((id: string) => {
    const s = saveRef.current
    if (s.reportedMilestones.includes(id)) return
    s.reportedMilestones.push(id)
    persistSave(s)
    if (vplayRef.current?.mode === 'vplay') VPlay.milestone(id)
  }, [])

  /** Cloud save with a 15-second throttle (localStorage stays the offline copy). */
  const saveCloudThrottled = useCallback((force = false) => {
    if (vplayRef.current?.mode !== 'vplay') return
    const now = Date.now()
    if (!force && now - lastCloudSaveRef.current < 15000) return
    lastCloudSaveRef.current = now
    const s = saveRef.current
    VPlay.saveCloud({ cash: s.cash, xp: s.xp, level: s.level, shards: s.shards, owned: s.owned, skin: s.skin, theme: s.theme, achievements: s.achievements, districts: s.districts, landmarks: s.landmarks, stats: s.stats, tutorialDone: s.tutorialDone })
  }, [])

  const commit = useCallback(() => {
    persistSave(saveRef.current)
    setSave({ ...saveRef.current })
    // Diff achievements/districts so each new one fires its milestone once.
    // Purchase achievements are excluded — rewarding a purchase is a loop.
    const s = saveRef.current
    for (const id of s.achievements) {
      if (!lastKnownRef.current.ach.includes(id)) {
        lastKnownRef.current.ach.push(id)
        if (id !== 'buy-skin' && id !== 'buy-theme') reportMilestone(`ach.${id}`)
      }
    }
    for (const id of s.districts) {
      if (!lastKnownRef.current.districts.includes(id)) {
        lastKnownRef.current.districts.push(id)
        reportMilestone(`district.${id}`)
      }
    }
    saveCloudThrottled()
  }, [reportMilestone, saveCloudThrottled])

  // ---- VPlay bootstrap: init, host events, visibility pause, cloud save ----
  useEffect(() => {
    let cancelled = false
    const unsubs: Array<() => void> = []
    VPlay.init({ gameId: 'neon-harbor', sdkVersion: 1 }).then((init) => {
      if (cancelled) return
      setVplay(init)
      setVcBalance(init.vcoins)
      setEntitlements(init.entitlements)
      entitlementsRef.current = init.entitlements
      // Cloud save wins when it is ahead of the local copy (level/xp compare)
      if (init.mode === 'vplay' && init.save && typeof init.save === 'object') {
        const cloud = init.save as Partial<SaveData>
        const local = saveRef.current
        const cloudXp = (cloud.level ?? 1) * 1000 + (cloud.xp ?? 0)
        const localXp = local.level * 1000 + local.xp
        if (cloudXp > localXp) {
          const merged: SaveData = {
            ...local,
            ...cloud,
            stats: { ...local.stats, ...(cloud.stats ?? {}) },
            owned: [...new Set([...(local.owned ?? []), ...(cloud.owned ?? [])])],
            reportedMilestones: local.reportedMilestones ?? [],
          }
          saveRef.current = merged
          persistSave(merged)
          setSave({ ...merged })
        }
      }
    })
    unsubs.push(VPlay.on('pause', () => {
      // host asked us to freeze — go quiet immediately, no interstitial yet
      engineRef.current?.setPaused(true)
      engineRef.current?.suspendAudio()
      VPlay.gameplayStop()
      saveCloudThrottled(true)
    }))
    unsubs.push(VPlay.on('resume', () => {
      // host is back — resume immediately. Audio may still need a gesture, so
      // we attempt resume quietly and let the next tap/click re-sync it.
      setHostPaused(false)
      engineRef.current?.setPaused(false)
      engineRef.current?.resumeAudio()
      VPlay.gameplayStart()
    }))
    unsubs.push(VPlay.on('mute', () => {
      saveRef.current.muted = true
      commit()
    }))
    unsubs.push(VPlay.on('unmute', () => {
      saveRef.current.muted = false
      commit()
    }))
    unsubs.push(VPlay.on('entitlements', (data) => {
      const list = (data as { entitlements?: string[] } | undefined)?.entitlements ?? []
      setEntitlements(list)
      entitlementsRef.current = list
    }))
    unsubs.push(VPlay.on('vcoins', (data) => {
      const bal = (data as { vcoins?: number } | undefined)?.vcoins
      if (typeof bal === 'number') setVcBalance(bal)
    }))
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        engineRef.current?.setPaused(true)
        engineRef.current?.suspendAudio()
        VPlay.gameplayStop()
        saveCloudThrottled(true)
        pausedByHiddenRef.current = true
      } else if (pausedByHiddenRef.current) {
        pausedByHiddenRef.current = false
        // Auto-resume on return — a tab switch must never leave the player
        // staring at a pause wall. Audio resumes quietly; the browser re-syncs
        // it on the next user gesture if it was blocked.
        setHostPaused(false)
        engineRef.current?.setPaused(false)
        engineRef.current?.resumeAudio()
        VPlay.gameplayStart()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      for (const u of unsubs) u()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Gameplay signals: driving vs menus (vplay.gg tracks session state)
  useEffect(() => {
    if (vplay?.mode !== 'vplay') return
    if (screen === 'game' && overlay === null && !hostPaused) VPlay.gameplayStart()
    else VPlay.gameplayStop()
  }, [screen, overlay, hostPaused, vplay])

  const ensureEngine = useCallback((): GameEngine | null => {
    if (engineRef.current) return engineRef.current
    const canvas = canvasRef.current
    const minimap = minimapRef.current
    const assets = assetsRef.current
    if (!canvas || !minimap || !assets) return null
    const engine = new GameEngine(canvas, minimap, {
      getSave: () => saveRef.current,
      commit,
      onHud: (h) => setHud(h),
      onToast: (msg, kind) => pushToast(msg, kind),
      onBusted: () => {
        setBustedFlash(true)
        window.setTimeout(() => setBustedFlash(false), 1800)
      },
      onWrecked: () => {
        setWreckFlash(true)
        window.setTimeout(() => setWreckFlash(false), 2200)
      },
      onLevelUp: (level) => pushToast(`LEVEL UP — you reached level ${level}!`, 'good'),
      onMilestone: (id) => reportMilestone(id),
      onMissionDone: (name, reward) => {
        pushToast(`${name} complete!  +$${reward}`, 'good')
        setWinBanner({ name, reward })
        window.setTimeout(() => setWinBanner((w) => (w && w.name === name ? null : w)), 10000)
      },
      onPressE: () => {
        if (screenRef.current === 'game' && overlayRef.current === null) setOverlay('jobs')
      },
      onPauseToggle: () => {
        if (screenRef.current !== 'game') return
        setOverlay((o) => (o === null ? 'pause' : o))
      },
      onPhotoToggle: () => {
        if (screenRef.current !== 'game') return
        setPhotoMode((m) => {
          engineRef.current?.setPhotoMode(!m)
          return !m
        })
      },
    }, assets)
    // Quality watchdog — now on EVERY platform: it is the thermal safety net
    // that steps quality down if the machine can't hold the frame rate (a
    // throttling laptop shows up as sustained low fps). Healthy desktops run
    // at the 60fps cap and never trigger it; touch/software rigs get lower
    // thresholds because their baseline is weaker.
    const software = engine.isSoftwareRenderer()
    engine.setAutoQualityEnabled(true, isTouch ? 42 : software ? 24 : 30)
    engine.setUiTouch(isTouch)
    engine.setOnboardingActive(onboardStep !== null)
    engineRef.current = engine
    // Dev-only introspection handle for automated play-testing (position,
    // speed, stuck state). Never shipped — tree-shaken from release builds.
    if (import.meta.env.DEV) (window as unknown as { __nh: unknown }).__nh = engine
    return engine
    // onboardStep intentionally omitted: the engine is created once and
    // setOnboardingActive is kept current by a separate effect.
  }, [commit, pushToast, isTouch, reportMilestone])

  // Load the 3D model packs first, then create the engine so the menus
  // float over the fully-built live city.
  useEffect(() => {
    let cancelled = false
    loadGameAssets((done, total) => {
      const pct = Math.round((done / Math.max(total, 1)) * 100)
      if (!cancelled) setLoadPct(pct)
      VPlay.loading(pct / 100)
    })
      .then((assets) => {
        if (cancelled) return
        assetsRef.current = assets
        setAssetsReady(true)
        VPlay.loading(1)
        try {
          ensureEngine()
        } catch (err) {
          pushToast(`Could not start: ${err instanceof Error ? err.message : String(err)}`, 'warn')
          throw err
        }
      })
      .catch((err) => {
        pushToast(`Could not load game models: ${err instanceof Error ? err.message : String(err)}`, 'warn')
      })
    return () => {
      cancelled = true
    }
  }, [ensureEngine, pushToast])

  // Fullscreen + landscape lock in one call. Must run inside a user gesture
  // (tap). Android Chrome honors both; iOS Safari silently ignores them (the
  // CSS-rotated root covers that case), so this never throws.
  const goImmersive = useCallback(() => {
    try {
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }
      const p = el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch { /* fullscreen not permitted — fine */ }
    try {
      const so = window.screen.orientation as unknown as { lock?: (o: string) => Promise<void> }
      const lp = so.lock?.('landscape')
      if (lp && typeof lp.catch === 'function') lp.catch(() => {})
    } catch { /* orientation lock unsupported */ }
  }, [])

  // First tap anywhere on a phone (splash card, menu, anywhere) goes immersive
  // immediately — launching feels instant, like the PC build opening maximized.
  useEffect(() => {
    if (!isTouch) return
    const onFirstTap = () => {
      if (vplayRef.current?.mode === 'vplay') return
      goImmersive()
      window.removeEventListener('pointerdown', onFirstTap)
    }
    window.addEventListener('pointerdown', onFirstTap)
    return () => window.removeEventListener('pointerdown', onFirstTap)
  }, [isTouch, goImmersive])

  // Enter the game world
  const enterGame = useCallback(() => {
    try {
      const engine = ensureEngine()
      if (!engine) throw new Error('Game engine could not start (canvas missing)')
      try {
        engine.startAudio()
      } catch {
        // Audio unavailable — the game still runs silently
      }
      engine.setMuted(saveRef.current.muted)
      engine.setAttract(false)
      // Phones/tablets: go truly fullscreen AND lock landscape (hide browser
      // chrome) — needs the user-gesture context of this click. Never in
      // vplay.gg iframe mode.
      if (isTouch && vplayRef.current?.mode !== 'vplay') {
        goImmersive()
      }
      setScreen('game')
      // First-run onboarding: once per device, tap-through spotlight tour.
      // Separate flag from the save file — save format untouched.
      if (!skipOnboard) {
        try {
          if (!window.localStorage.getItem(ONBOARD_KEY)) setOnboardStep(0)
        } catch {
          /* private mode — show it anyway */
        }
      }
    } catch (err) {
      pushToast(`Could not start: ${err instanceof Error ? err.message : String(err)}`, 'warn')
      throw err
    }
  }, [ensureEngine, pushToast, isTouch, skipOnboard])

  // Phones: rotating to landscape while playing should also hide the browser
  // chrome (URL bar). iOS Safari silently ignores it — the CSS-rotated root
  // covers portrait there — so this is a no-op, never an error.
  useEffect(() => {
    if (!isTouch || screen !== 'game') return
    const goFullscreen = () => {
      if (vplayRef.current?.mode === 'vplay') return
      if (window.innerWidth <= window.innerHeight) goImmersive()
    }
    window.addEventListener('orientationchange', goFullscreen)
    window.addEventListener('resize', goFullscreen)
    return () => {
      window.removeEventListener('orientationchange', goFullscreen)
      window.removeEventListener('resize', goFullscreen)
    }
  }, [isTouch, screen, goImmersive])

  enterGameRef.current = enterGame

  // Keep the engine in sync with UI state: while the tap-through onboarding
  // tour is up, the engine's FIRST NIGHT tutorial stays hidden and frozen —
  // one guide at a time. uiTouch drives toast wording (touch vs desktop).
  useEffect(() => {
    engineRef.current?.setOnboardingActive(onboardStep !== null)
  }, [onboardStep])
  useEffect(() => {
    engineRef.current?.setUiTouch(isTouch)
  }, [isTouch])

  // Dev-only test hooks (?autostart / ?theme / ?hud=0) — never active in the
  // shipped build. The engine handle is likewise dev-only.
  useEffect(() => {
    if (!assetsReady || !import.meta.env.DEV) return
    const params = new URLSearchParams(window.location.search)
    const th = params.get('theme')
    if (th && THEMES.some((t) => t.id === th)) {
      saveRef.current.theme = th
      commit()
      engineRef.current?.applyLoadout()
    }
    if (params.get('hud') === '0') document.body.classList.add('nh-cinema')
    if (params.has('unlock')) {
      // DEV-ONLY test hook: ?unlock=all grants every car, environment and max
      // level so testers skip the progression. Never active in shipped builds.
      const s = saveRef.current
      s.owned = [...new Set([...s.owned, ...SKINS.map((k) => k.id), ...THEMES.map((t) => t.id), 'aurora'])]
      s.level = Math.max(s.level, 10)
      s.cash = Math.max(s.cash, 99999)
      commit()
      engineRef.current?.applyLoadout()
    }
    if (params.has('autostart')) {
      enterGame()
      if (params.get('at') === 'beach') {
        engineRef.current?.debugTeleport(8, 226, Math.PI)
      }
      ;(window as unknown as { __nh?: unknown }).__nh = engineRef.current
    }
  }, [assetsReady, enterGame, commit])

  // Engine handle for live debugging — development builds only
  useEffect(() => {
    if (import.meta.env.DEV && engineRef.current) {
      (window as unknown as { __nh?: unknown }).__nh = engineRef.current
    }
  }, [screen])

  // City map: size the canvas to its box on open, then keep repainting it
  // live (~12fps) — on touch the game keeps running behind the panel, so the
  // player dot, route and patrols must move in real time like CoD's big map.
  const tacMapRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (overlay !== 'map') return
    const canvas = tacMapRef.current
    const engine = engineRef.current
    if (!canvas || !engine) return
    const rect = canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const px = Math.max(Math.round(Math.min(rect.width, rect.height) * dpr), 320)
    canvas.width = px
    canvas.height = px
    let raf = 0
    let last = 0
    const tick = (t: number) => {
      if (t - last > 80) {
        last = t
        engine.drawTacMap(canvas)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [overlay])

  // Pause only for modal overlays during gameplay — menus keep the city alive.
  // Exception: the tactical map on touch is a non-modal side panel — the game
  // keeps running so the player can navigate while driving.
  useEffect(() => {
    engineRef.current?.setPaused(screen === 'game' && (overlay !== null && !(isTouch && overlay === 'map')))
    // Never leave a held touch button "stuck" when a menu opens over the game
    if (overlay !== null) engineRef.current?.touchReset()
    // Any menu opening exits photo mode cleanly
    if (overlay !== null && photoMode) {
      engineRef.current?.setPhotoMode(false)
      setPhotoMode(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, screen, isTouch])

  // Escape opens/closes pause (or dismisses the tactical map first)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (screenRef.current !== 'game') return
      setOverlay((o) => (o === 'map' ? null : o === null ? 'pause' : o === 'pause' ? null : o))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // M toggles the PUBG-style tactical map (desktop)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'm' && e.key !== 'M') return
      if (screenRef.current !== 'game') return
      setOverlay((o) => (o === null ? 'map' : o === 'map' ? null : o))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      engineRef.current?.dispose()
      engineRef.current = null
    }
  }, [])

  const quitToMenu = () => {
    engineRef.current?.cancelMission()
    engineRef.current?.setPhotoMode(false)
    setPhotoMode(false)
    engineRef.current?.setAttract(true)
    setOverlay(null)
    setScreen('menu')
  }

  // Photo mode: freeze the world, orbit, filter, save a still
  const togglePhoto = () => {
    if (screen !== 'game') return
    setPhotoMode((m) => {
      engineRef.current?.setPhotoMode(!m)
      return !m
    })
  }

  const savePhoto = () => {
    const url = engineRef.current?.capturePhoto()
    if (!url) {
      pushToast('Could not capture photo', 'warn')
      return
    }
    const a = document.createElement('a')
    a.href = url
    a.download = `neon-harbor-${Date.now()}.png`
    a.click()
    pushToast('📸 Photo saved to your downloads!', 'good')
  }

  const toggleMute = () => {
    const s = saveRef.current
    s.muted = !s.muted
    engineRef.current?.setMuted(s.muted)
    commit()
  }

  // PC-5: auto day/night cycle — rotate through owned themes on a timer
  const toggleCycle = () => {
    const s = saveRef.current
    s.autoCycle = !s.autoCycle
    commit()
    setSave({ ...s })
    pushToast(s.autoCycle ? 'Environment cycle ON — the city shifts over time' : 'Environment cycle OFF', 'info')
  }

  // MOB-1: switch between virtual joystick and classic touch buttons
  const toggleControls = () => {
    const s = saveRef.current
    s.controls = s.controls === 'joystick' ? 'buttons' : 'joystick'
    commit()
    setSave({ ...s })
    engineRef.current?.touchAnalog(null, null)
    engineRef.current?.touchReset()
    pushToast(s.controls === 'joystick' ? 'Joystick controls — push forward to drive' : 'Button controls', 'info')
  }

  useEffect(() => {
    if (screen !== 'game' || !save.autoCycle) return
    const id = window.setInterval(() => {
      const s = saveRef.current
      const ownedThemes = THEMES.filter((t) => s.owned.includes(t.id))
      if (ownedThemes.length < 2) return
      const idx = Math.max(0, ownedThemes.findIndex((t) => t.id === s.theme))
      const next = ownedThemes[(idx + 1) % ownedThemes.length]
      s.theme = next.id
      commit()
      engineRef.current?.applyLoadout()
      pushToast(`Environment shifting — ${next.name}`, 'info')
    }, 80000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, save.autoCycle])

  // PC-6: save export / import — players can carry progress between devices
  const exportSave = () => {
    const blob = new Blob([JSON.stringify(saveRef.current, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'neon-harbor-save.json'
    a.click()
    URL.revokeObjectURL(a.href)
    pushToast('Save file downloaded — keep it safe!', 'good')
  }

  const importSaveFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as Partial<SaveData>
        if (typeof parsed.cash !== 'number' || typeof parsed.level !== 'number') throw new Error('not a save')
        const fresh = defaultSave()
        const merged: SaveData = {
          ...fresh,
          ...parsed,
          stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
          shards: Array.isArray(parsed.shards) ? parsed.shards : [],
          owned: Array.isArray(parsed.owned) && parsed.owned.length > 0 ? parsed.owned : fresh.owned,
          achievements: Array.isArray(parsed.achievements) ? parsed.achievements : [],
          districts: Array.isArray(parsed.districts) ? parsed.districts : [],
        }
        saveRef.current = merged
        persistSave(merged)
        setSave({ ...merged })
        engineRef.current?.applyLoadout()
        pushToast('Save imported — welcome back to the harbor!', 'good')
      } catch {
        pushToast('That file is not a valid NEON HARBOR save', 'warn')
      }
    }
    reader.readAsText(file)
  }
  const fileRef = useRef<HTMLInputElement>(null)

  const buyItem = (id: string, price: number, premium: boolean, minLevel: number) => {
    const engine = engineRef.current
    const s = saveRef.current
    if (premium && !isOwned(id)) {
      engine?.playDenied()
      pushToast(vplay?.mode === 'vplay' ? 'Unlock this with VCoins on vplay.gg' : 'Unlock this on vplay.gg', 'warn')
      return
    }
    if (s.owned.includes(id)) return
    if (s.level < minLevel) {
      engine?.playDenied()
      pushToast(`Requires level ${minLevel}`, 'warn')
      return
    }
    if (s.cash < price) {
      engine?.playDenied()
      pushToast('Not enough cash — take on more jobs!', 'warn')
      return
    }
    s.cash -= price
    s.owned.push(id)
    engine?.playBuy()
    engine?.unlockAchievement(SKINS.some((k) => k.id === id) ? 'buy-skin' : 'buy-theme')
    commit()
    pushToast('Purchased — equipped!', 'good')
    equipItem(id)
  }

  // Performance upgrades: cash-only, levels persist in the save. The engine
  // reads save.upgrades every frame, so buying takes effect immediately.
  const buyUpgrade = (id: UpgradeId) => {
    const engine = engineRef.current
    const s = saveRef.current
    const def = UPGRADES.find((u) => u.id === id)
    if (!def) return
    const lv = s.upgrades[id] ?? 0
    if (lv >= def.max) return
    const price = def.prices[lv]
    if (s.cash < price) {
      engine?.playDenied()
      pushToast('Not enough cash — take on more jobs!', 'warn')
      return
    }
    s.cash -= price
    s.upgrades[id] = lv + 1
    engine?.playBuy()
    commit()
    pushToast(`${def.icon} ${def.name} Lv${lv + 1} installed!`, 'good')
  }

  // VCoin quick-buy: vplay.gg shows its own confirm sheet and owns the ledger.
  const buyVc = async (id: string, vcId: string) => {
    const engine = engineRef.current
    if (isOwned(id) || vplay?.mode !== 'vplay') return
    const result: PurchaseResult = await VPlay.purchase(vcId)
    if (result.status === 'purchased') {
      setEntitlements(result.entitlements)
      entitlementsRef.current = result.entitlements
      setVcBalance(result.vcoins)
      engine?.playBuy()
      engine?.unlockAchievement(SKINS.some((k) => k.id === id) ? 'buy-skin' : 'buy-theme')
      commit()
      saveCloudThrottled(true)
      const isEquipable = SKINS.some((k) => k.id === id) || THEMES.some((t) => t.id === id)
      pushToast(isEquipable ? 'Owned — equipped!' : 'HARBOR PASS unlocked!', 'good')
      if (isEquipable) equipItem(id) // the pass itself is not a skin/theme — never equip it
    } else if (result.status === 'needs_signin') {
      pushToast('Sign in on vplay.gg to buy with VCoins', 'info')
    } else if (result.status === 'insufficient') {
      pushToast('Not enough VCoins — top up on vplay.gg', 'warn')
    } else if (result.status === 'cancelled') {
      /* player closed the sheet — nothing happened */
    } else {
      pushToast('Purchase unavailable right now — try again soon', 'warn')
    }
  }

  /** Effective ownership: local (free/cash) OR vplay.gg entitlement OR Harbor Pass. */
  const isOwned = (id: string): boolean => {
    if (save.owned.includes(id)) return true
    const ents = entitlementsRef.current
    if (id === HARBOR_PASS_ID) return ents.includes(HARBOR_PASS_ID)
    const item = SKINS.find((k) => k.id === id) ?? THEMES.find((t) => t.id === id)
    if (!item?.vcId) return false
    return ents.includes(item.vcId) || (item.premium && ents.includes(HARBOR_PASS_ID))
  }

  /** Harbor Pass live price from vplay.gg (display only). */
  const passPrice = vplay?.items.find((i) => i.id === HARBOR_PASS_ID)?.priceVc

  /** VCoin price for a shop item, as advertised by vplay.gg. */
  const vcPriceOf = (item: { vcId?: string }): number | null => {
    if (!item.vcId || vplay?.mode !== 'vplay') return null
    return vplay.items.find((i) => i.id === item.vcId)?.priceVc ?? null
  }

  const equipItem = (id: string) => {
    const s = saveRef.current
    if (SKINS.some((k) => k.id === id)) s.skin = id
    else s.theme = id
    commit()
    engineRef.current?.applyLoadout()
  }

  const owned = (id: string) => isOwned(id)

  // Aurora Prime: earned prestige paint — all achievements + level 10
  useEffect(() => {
    const s = saveRef.current
    if (s.achievements.length >= ACHIEVEMENTS.length && s.level >= 10 && !s.owned.includes('aurora')) {
      s.owned.push('aurora')
      commit()
      pushToast('🏆 AURORA PRIME earned — the harbor bows to you!', 'good')
      engineRef.current?.applyLoadout()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save.achievements.length, save.level])

  const resetProgress = () => {
    if (!confirmReset) {
      setConfirmReset(true)
      return
    }
    const fresh = defaultSave()
    fresh.muted = saveRef.current.muted
    saveRef.current = fresh
    persistSave(fresh)
    setSave({ ...fresh })
    engineRef.current?.applyLoadout()
    setConfirmReset(false)
    pushToast('Progress reset', 'info')
  }

  return (
    <div
      className="fixed inset-0 overflow-hidden bg-black font-game select-none"
      style={
        isTouch && isPortrait
          ? {
              // Present the game in landscape even while the phone is held
              // upright — the player never has to do anything.
              inset: 'auto',
              top: 0,
              left: 0,
              width: window.innerHeight,
              height: window.innerWidth,
              transform: 'rotate(90deg) translateY(-100%)',
              transformOrigin: 'left top',
            }
          : undefined
      }
    >
      {/* 3D canvas (live behind every screen) — photo filters tint only in photo mode */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full block"
        style={{ filter: photoMode ? PHOTO_FILTERS[photoFilter].css : undefined }}
      />

      {/* minimap canvas — always mounted, engine needs it before entering.
          TAP IT to expand the big AMap-style city map (CoD Mobile pattern:
          the minimap itself is the button — no hunting for a tiny icon). */}
      <canvas
        ref={minimapRef}
        width={180}
        height={180}
        onPointerDown={() => {
          if (screen === 'game') setOverlay((o) => (o === 'map' ? null : 'map'))
        }}
        className={`nh-minimap absolute z-20 rounded-lg border border-cyan-500/30 shadow-[0_0_20px_rgba(34,211,238,0.25)] cursor-pointer ${isTouch ? 'top-2 right-2 w-24 h-24 opacity-85' : 'top-4 right-4'} ${screen === 'game' && hud ? '' : 'hidden'}`}
      />

      {/* ================= OPENING SPLASH (logos, tap to skip) ================= */}
      {splashStep < 2 && (
        <button
          onClick={() => setSplashStep(2)}
          className="absolute inset-0 z-[60] flex flex-col items-center justify-center bg-[#05060f] cursor-pointer overflow-hidden"
          aria-label="Skip intro"
        >
          {splashStep === 0 && (
            <div className="menu-in flex flex-col items-center px-6">
              <img
                src="logos/varygaming.png"
                alt="Vary Gaming"
                className="nh-splash-logo w-[78vw] max-w-xl md:max-w-2xl drop-shadow-[0_0_28px_rgba(34,211,238,0.35)]"
                draggable={false}
              />
              <div className="nh-splash-kicker text-slate-500 tracking-[0.55em] text-xs md:text-sm mt-6 animate-pulse">PRESENTS</div>
            </div>
          )}
          {splashStep === 1 && (
            <div className="menu-in flex flex-col items-center px-6">
              <img
                src="logos/vplaygg.svg"
                alt="vplay.gg"
                className="nh-splash-logo w-[70vw] max-w-lg md:max-w-xl drop-shadow-[0_0_28px_rgba(59,130,246,0.4)]"
                draggable={false}
              />
              <div className="nh-splash-sub text-slate-400 tracking-[0.55em] text-xs md:text-sm mt-6 animate-pulse">E X C L U S I V E</div>
            </div>
          )}
          <div className="absolute bottom-8 text-slate-600 text-[11px] tracking-[0.3em]">TAP TO SKIP</div>
        </button>
      )}

      {/* ================= BOOT ================= */}
      {screen === 'boot' && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-gradient-to-b from-[#05060f]/85 via-[#0a0d1f]/70 to-[#05060f]/85">
          <h1 className="nh-title text-6xl md:text-8xl font-black text-white neon-cyan tracking-wider">{GAME_TITLE}</h1>
          <div className="text-fuchsia-500 tracking-[0.4em] mt-2 text-sm md:text-base">FIRST LIGHT</div>
          <img src="logos/vplaygg.svg" alt="vplay.gg exclusive" className="h-7 md:h-8 mt-4 opacity-95" draggable={false} />
          <p className="nh-boot-desc text-slate-300 mt-6 max-w-md text-center px-4 text-sm leading-relaxed">
            An open-world neon port city. Run courier jobs, race the harbor, outrun the Patrol — and build your legend.
          </p>
          {assetsReady ? (
            <button
              onClick={enterGame}
              className="nh-boot-btn mt-10 px-12 py-4 bg-cyan-500/20 border border-cyan-400 text-cyan-300 text-xl tracking-[0.3em] rounded hover:bg-cyan-400/30 hover:shadow-[0_0_30px_rgba(34,211,238,0.5)] transition-all btn-attend"
            >
              ENTER THE HARBOR
            </button>
          ) : (
            <div className="mt-10 w-72">
              <div className="text-cyan-300/80 text-xs tracking-[0.3em] mb-2 text-center">
                LOADING CITY MODELS — {loadPct}%
              </div>
              <div className="h-2 bg-cyan-950 border border-cyan-800 rounded overflow-hidden">
                <div
                  className="h-full bg-cyan-400 transition-all duration-200"
                  style={{ width: `${loadPct}%` }}
                />
              </div>
            </div>
          )}
          {/* Carried-over damage is said out loud on the FIRST screen every
              visit — a returning player never drives a dented car blind. */}
          {save.damage > 0 && (
            <div className="mt-4 px-4 py-2 rounded-lg border border-amber-400/50 bg-amber-500/10 text-amber-200 text-xs tracking-wide text-center max-w-sm">
              🔧 Your car needs a repair — body at {Math.round(save.damage)}%. Fix it in the GARAGE SHOP.
            </div>
          )}
          <p className="text-slate-500 text-xs mt-8">Headphones recommended — sound starts on entry</p>
        </div>
      )}

      {/* ================= MAIN MENU ================= */}
      {screen === 'menu' && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/55 backdrop-blur-[2px]">
          <h1 className="nh-menu-title text-5xl md:text-7xl font-black text-white neon-cyan tracking-wider">{GAME_TITLE}</h1>
          <img src="logos/vplaygg.svg" alt="vplay.gg exclusive" className="nh-menu-tag h-5 mt-3 opacity-90" draggable={false} />
          <div className={`nh-menu-gap flex menu-in ${isTouch ? 'flex-col w-64 items-stretch gap-2 mt-6' : 'gap-3 mt-10'}`}>
            <button onClick={enterGame} className="menu-btn menu-btn-primary btn-attend">DRIVE</button>
            <button onClick={() => setOverlay('shop')} className="menu-btn">GARAGE SHOP</button>
            <button onClick={() => setOverlay('help')} className="menu-btn">HOW TO PLAY</button>
          </div>
          <div className={`nh-menu-gap flex menu-in ${isTouch ? 'flex-col w-64 items-stretch gap-2 mt-3' : 'gap-3 mt-3'}`}>
            <button onClick={() => { setProgressTab('trophies'); setOverlay('progress') }} className="menu-btn menu-btn-ghost">🏆 TROPHIES</button>
            <button onClick={() => { setProgressTab('districts'); setOverlay('progress') }} className="menu-btn menu-btn-ghost">🗺️ DISTRICTS</button>
            <button onClick={() => setOverlay('shop')} className="menu-btn menu-btn-ghost border-amber-400/60 text-amber-300 btn-attend-amber">🔓 HARBOR PASS</button>
          </div>
          <div className={`nh-menu-stats ${isTouch ? 'mt-6 text-xs flex flex-wrap justify-center gap-x-4 gap-y-1 px-3' : 'mt-10 text-sm flex gap-8'} text-slate-300`}>
            <span>Cash <b className="text-emerald-400">${save.cash}</b></span>
            <span>Level <b className="text-cyan-400">{save.level}</b></span>
            <span>Shards <b className="text-cyan-400">{save.shards.length}/24</b></span>
            <span>Deliveries <b className="text-cyan-400">{save.stats.deliveries}</b></span>
            <span>Races <b className="text-cyan-400">{save.stats.races}</b></span>
            <span>Cred <b className="text-amber-300">{save.stats.cred.toLocaleString()}</b></span>
          </div>
          {/* Night Shift: a returning player sees tonight's goals before driving */}
          {save.tutorialDone && save.shift.goals.length > 0 && (
            <div className="menu-in mt-2 text-xs text-indigo-300 tracking-wide text-center px-3">
              🌙 Night Shift {save.shift.goals.filter((g) => g.done).length}/{save.shift.goals.length} done
              {save.shift.goals.find((g) => !g.done) && <> — next: {save.shift.goals.find((g) => !g.done)!.label}</>}
            </div>
          )}
          {/* Carried-over body damage is a feature — but never a mystery.
              Say it once, here on the title screen, before they drive. */}
          {save.damage > 0 && (
            <div className="menu-in mt-3 px-4 py-2 rounded-lg border border-amber-400/50 bg-amber-500/10 text-amber-200 text-xs tracking-wide text-center">
              🔧 Your car needs a repair — body at {Math.round(save.damage)}%. Fix it in the GARAGE SHOP.
            </div>
          )}
          <button onClick={toggleMute} className="nh-menu-gap mt-6 text-slate-500 text-xs underline hover:text-slate-300">
            {save.muted ? 'Unmute sound' : 'Mute sound'}
          </button>
          <button onClick={resetProgress} className="mt-2 text-slate-600 text-xs underline hover:text-red-400">
            {confirmReset ? 'Click again to CONFIRM reset (cannot be undone)' : 'Reset progress'}
          </button>
        </div>
      )}

      {/* ================= HUD ================= */}
      {screen === 'game' && hud && !photoMode && (
        <>
          {/* top-left: cash / level — one slim chip on mobile, full panel on desktop */}
          <div className={`absolute top-4 left-4 z-20 ${isTouch ? 'flex items-center gap-1.5' : 'space-y-2'}`}>
            <div className={`hud-panel font-bold text-emerald-400 ${isTouch ? 'text-sm px-2.5 py-1.5' : 'text-2xl'}`}>${hud.cash.toLocaleString()}</div>
            {hud.chainMult > 1 && (
              <div className="hud-panel border-fuchsia-400/60 text-fuchsia-300 text-xs font-black tracking-widest animate-pulse">
                STREET CRED ×{hud.chainMult.toFixed(2)}
              </div>
            )}
            {isTouch ? (
              <div className="hud-panel text-[11px] text-slate-300 px-2.5 py-1.5">
                LVL <b className="text-cyan-300">{hud.level}</b>
                <span className="mx-1 text-slate-600">|</span>◆ <b className="text-cyan-300">{hud.shards}/{hud.totalShards}</b>
              </div>
            ) : (
              <div className="hud-panel">
                <div className="flex justify-between text-[11px] text-slate-300">
                  <span>LVL {hud.level}</span>
                  <span>{hud.xp}/{hud.xpNext} XP</span>
                </div>
                <div className="w-44 h-2 bg-slate-800 rounded mt-1">
                  <div className="h-full bg-cyan-400 rounded" style={{ width: `${Math.min((hud.xp / hud.xpNext) * 100, 100)}%` }} />
                </div>
              </div>
            )}
          </div>

          {/* top-center notification stack — DESKTOP ONLY. On mobile nothing
              may sit in front of the car: every gameplay-time text lives in
              the right-side notification column under the minimap instead. */}
          {!isTouch && (
          <div className="absolute left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1.5 w-full px-3 pointer-events-none top-4">
            {hud.mission ? (
              <div className="hud-panel border-yellow-400/40 w-56 max-w-[62vw] sm:w-[26rem] sm:max-w-[80vw]">
                <div className="flex justify-between items-center">
                  <span className="text-yellow-300 font-bold text-sm">{hud.mission.name}</span>
                  {hud.mission.timer >= 0 ? (
                    <span className={`font-mono text-lg font-bold ${hud.mission.timer < 10 ? 'text-red-400 animate-pulse' : 'text-white'}`}>
                      {Math.max(0, hud.mission.timer).toFixed(1)}s
                    </span>
                  ) : (
                    <span className="font-mono text-lg font-bold text-red-400 animate-pulse">EVADE</span>
                  )}
                </div>
                <div className="flex justify-between text-[11px] text-slate-300 mt-1">
                  <span>{hud.mission.stage === 'pickup' ? 'Reach the pickup beacon' : hud.mission.stage}</span>
                  {hud.mission.timer >= 0 && <span>{Math.round(hud.mission.dist)}m</span>}
                </div>
                {/* live risk–reward: the payout explains itself as you drive */}
                <div className="text-[11px] mt-1 font-bold text-emerald-300">
                  PAYOUT ~${hud.mission.payoutEst.toLocaleString()}
                  {hud.mission.heatMult > 1 && <span className="text-red-300"> · HEAT ×{hud.mission.heatMult}</span>}
                  {hud.mission.credPct > 0 && <span className="text-amber-300"> · CRED +{hud.mission.credPct}%</span>}
                </div>
              </div>
            ) : hud.marker ? (
              /* contract beacon accept card — drive in, read the terms, press E */
              <div className={`hud-panel ${JOB_BORDER_CLS[hud.marker.kind] ?? 'border-cyan-400/40'} w-56 max-w-[62vw] sm:w-[22rem] sm:max-w-[80vw]`}>
                <div className="flex justify-between items-center">
                  <span className={`font-bold text-sm ${JOB_TEXT_CLS[hud.marker.kind] ?? 'text-cyan-300'}`}>{JOB_LABEL[hud.marker.kind] ?? hud.marker.kind}</span>
                  <span className="text-[11px] text-slate-300">press <span className="key-cap">E</span> to accept</span>
                </div>
                {hud.marker.mods.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {hud.marker.mods.map((chip) => (
                      <span key={chip} className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-white/10 border border-white/20 text-slate-100">{chip}</span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="hud-panel text-center text-[13px] text-slate-300">
                <>Free roam — drive into a <span className="text-cyan-300">colored beacon</span> for a job, or visit the <span className="text-cyan-300">garage</span> for the full board</>
              </div>
            )}

            {/* FIRST NIGHT objective — compact notification pill; ✕ dismisses for this run */}
            {hud.tutorial && !tutorialHidden && (
              <div key={hud.tutorial.step} className="tutorial-dim">
                <div className="hud-panel border-cyan-400/70 shadow-[0_0_28px_rgba(34,211,238,0.3)] w-64 max-w-[62vw] sm:w-[24rem] sm:max-w-[80vw]">
                  <div className="flex justify-between items-center text-[10px] tracking-[0.2em] text-cyan-300">
                    <span>FIRST NIGHT {hud.tutorial.step}/{hud.tutorial.total}</span>
                    <span className="flex items-center gap-2">
                      {!isTouch && <span className="text-slate-500 hidden sm:inline">press T to skip</span>}
                      <button
                        onClick={() => setTutorialHidden(true)}
                        className="text-slate-400 hover:text-white leading-none pointer-events-auto"
                        aria-label="Hide tutorial"
                      >✕</button>
                    </span>
                  </div>
                  <div className="text-white font-bold leading-snug text-xs mt-0.5 sm:text-base">{isTouch ? touchTitle(hud.tutorial.title) : hud.tutorial.title}</div>
                  <div className="text-slate-200 leading-relaxed text-[11px] sm:text-[13px]">{isTouch ? touchHint(hud.tutorial.hint) : hintWithKeys(hud.tutorial.hint)}</div>
                </div>
              </div>
            )}

          </div>
          )}

          {/* top-right (below minimap): CoDM-style dispatch feed — game info lands
              here, under the minimap, so it never covers the driving view — plus
              the heat panel with live police instructions (slim on mobile).
              ON MOBILE this column is THE notification shade: ACTION MODE, the
              mission tracker, the FIRST NIGHT guide, mission-complete and toasts
              all stack here at the edge — nothing ever floats in front of the car. */}
          <div className={`absolute z-20 flex flex-col items-end gap-2 ${isTouch ? `nc-col${save.controls === 'buttons' ? ' nc-pads' : ''}` : 'top-[196px] right-4'}`}>
            {/* utility row — Map / Horn (+ contextual E / Reset) docked at the
                top of the notification column, right under the minimap */}
            {isTouch && (!overlay || overlay === 'map') && (
              <div className="flex gap-2 pointer-events-auto">
                {(hud.nearGarage || hud.marker) && <TouchBtn engine={engineRef.current} label="E" aria="Accept job" tap="e" small />}
                {hud.stuck && <TouchBtn engine={engineRef.current} label={<IcoReset />} aria="Reset car" tap="r" small />}
                <button onClick={() => setOverlay(overlay === 'map' ? null : 'map')} className="touch-btn touch-btn-sm" aria-label="Map"><IcoMap /></button>
                <TouchBtn engine={engineRef.current} label={<IcoHorn />} aria="Horn" tap="h" small />
              </div>
            )}
            {/* ACTION MODE — pinned alert pill while the Patrol is chasing (mobile) */}
            {isTouch && hud.pursued && !hud.busted && !overlay && (
              <div className="nc-action pointer-events-none px-2.5 py-1 rounded-md border border-red-500/80 bg-red-950/70 backdrop-blur-sm text-red-300 font-black tracking-[0.18em] text-[10px] animate-pulse">
                ⚠ ACTION MODE — SAVE YOURSELF
              </div>
            )}
            {/* mission tracker — compact edge card (mobile) */}
            {isTouch && hud.mission && (
              <div className="nc-mission hud-panel border-yellow-400/40 w-44 px-2 py-1.5 pointer-events-none">
                <div className="flex justify-between items-center gap-2">
                  <span className="text-yellow-300 font-bold text-[11px] leading-tight">{hud.mission.name}</span>
                  {hud.mission.timer >= 0 ? (
                    <span className={`font-mono text-sm font-bold shrink-0 ${hud.mission.timer < 10 ? 'text-red-400 animate-pulse' : 'text-white'}`}>
                      {Math.max(0, hud.mission.timer).toFixed(1)}s
                    </span>
                  ) : (
                    <span className="font-mono text-sm font-bold text-red-400 animate-pulse shrink-0">EVADE</span>
                  )}
                </div>
                <div className="nc-stage flex justify-between text-[10px] text-slate-300 mt-0.5 gap-2">
                  <span className="leading-tight">{hud.mission.stage === 'pickup' ? 'Reach the pickup beacon' : hud.mission.stage}</span>
                  {hud.mission.timer >= 0 && <span className="shrink-0">{Math.round(hud.mission.dist)}m</span>}
                </div>
                <div className="text-[10px] mt-0.5 font-bold text-emerald-300">
                  ~${hud.mission.payoutEst.toLocaleString()}
                  {hud.mission.heatMult > 1 && <span className="text-red-300"> ×{hud.mission.heatMult} heat</span>}
                  {hud.mission.credPct > 0 && <span className="text-amber-300"> +{hud.mission.credPct}% cred</span>}
                </div>
              </div>
            )}
            {/* contract beacon accept card — edge-docked like the mission tracker (mobile) */}
            {isTouch && !hud.mission && hud.marker && !overlay && (
              <div className={`nc-mission hud-panel ${JOB_BORDER_CLS[hud.marker.kind] ?? 'border-cyan-400/40'} w-44 px-2 py-1.5 pointer-events-none`}>
                <div className={`font-bold text-[11px] leading-tight ${JOB_TEXT_CLS[hud.marker.kind] ?? 'text-cyan-300'}`}>
                  {JOB_LABEL[hud.marker.kind] ?? hud.marker.kind}
                </div>
                {hud.marker.mods.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {hud.marker.mods.map((chip) => (
                      <span key={chip} className="text-[9px] font-bold px-1 py-0.5 rounded bg-white/10 border border-white/20 text-slate-100">{chip}</span>
                    ))}
                  </div>
                )}
                <div className="text-[10px] text-slate-300 mt-0.5">Tap <span className="key-cap">E</span> to accept</div>
              </div>
            )}
            {/* FIRST NIGHT guide — same card, edge-docked with ✕ (mobile) */}
            {/* FIRST NIGHT guide — same card, edge-docked with ✕ (mobile).
                On short landscape screens a police chase takes priority:
                the card steps aside while pursued and resumes after. */}
            {isTouch && hud.tutorial && !tutorialHidden && !(compactHud && hud.pursued) && (
              <div key={hud.tutorial.step} className="nc-tut tutorial-dim w-48">
                <div className="hud-panel border-cyan-400/70 shadow-[0_0_28px_rgba(34,211,238,0.3)]" style={{ background: 'rgba(2,6,18,0.88)' }}>
                  <div className="flex justify-between items-center text-[9px] tracking-[0.2em] text-cyan-300">
                    <span>FIRST NIGHT {hud.tutorial.step}/{hud.tutorial.total}</span>
                    <button
                      onClick={() => setTutorialHidden(true)}
                      className="text-slate-400 hover:text-white leading-none pointer-events-auto"
                      aria-label="Hide tutorial"
                    >✕</button>
                  </div>
                  <div className="nc-title text-white font-bold leading-snug text-[11px] mt-0.5">{touchTitle(hud.tutorial.title)}</div>
                  <div className="nc-hint text-slate-200 leading-relaxed text-[10px]">{touchHint(hud.tutorial.hint)}</div>
                </div>
              </div>
            )}
            {/* mission-complete — compact edge card with photo + dismiss (mobile) */}
            {isTouch && winBanner && !overlay && !photoMode && (
              <div className="hud-panel border-emerald-400/70 shadow-[0_0_28px_rgba(52,211,153,0.35)] w-48 px-2.5 py-1.5 flex items-center gap-2">
                <div className="min-w-0">
                  <div className="text-[9px] tracking-[0.25em] text-emerald-300">MISSION COMPLETE</div>
                  <div className="text-white font-bold text-[11px] leading-tight truncate">{winBanner.name} <span className="text-emerald-400">+${winBanner.reward}</span></div>
                </div>
                <button
                  onClick={() => { setWinBanner(null); togglePhoto() }}
                  className="touch-btn touch-btn-sm shrink-0"
                  aria-label="Photo mode"
                >
                  <IcoCam />
                </button>
                <button
                  onClick={() => setWinBanner(null)}
                  className="text-slate-400 hover:text-white leading-none shrink-0"
                  aria-label="Dismiss"
                >✕</button>
              </div>
            )}
            {/* NIGHT SHIFT — 3 small goals, never expire; collapsible edge card */}
            {hud.shift && !overlay && (
              <div className={`hud-panel border-indigo-400/40 ${isTouch ? 'w-44 px-2 py-1' : 'w-56 px-3 py-2'}`}>
                <button
                  onClick={() => setShiftOpen(!shiftOpen)}
                  className="flex justify-between items-center w-full pointer-events-auto"
                  aria-label="Toggle Night Shift goals"
                >
                  <span className={`tracking-[0.2em] text-indigo-300 font-bold ${isTouch ? 'text-[9px]' : 'text-[10px]'}`}>
                    🌙 SHIFT {hud.shift.done}/{hud.shift.total}
                  </span>
                  <span className="text-slate-500 text-[10px]">{shiftOpen ? '▾' : '▸'}</span>
                </button>
                {shiftOpen && (
                  <div className="mt-1 flex flex-col gap-0.5">
                    {hud.shift.goals.map((g) => (
                      <div key={g.label} className={`flex justify-between gap-2 leading-tight ${isTouch ? 'text-[9px]' : 'text-[11px]'} ${g.done ? 'text-emerald-300 line-through opacity-70' : 'text-slate-200'}`}>
                        <span>{g.label}</span>
                        <span className="shrink-0 font-mono">{g.progress}/{g.target}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!isTouch && toasts.length > 0 && (
              <div className="flex flex-col items-end gap-1 pointer-events-none">
                {toasts.map((t) => (
                  <div key={t.id} className={`toast toast-feed toast-${t.kind}`}>
                    <span className="toast-tag">[{t.kind === 'cash' ? 'PAYOUT' : t.kind === 'warn' ? 'ALERT' : t.kind === 'good' ? 'HARBOR RADIO' : 'DISPATCH'}]</span>
                    <span>{t.msg}</span>
                  </div>
                ))}
              </div>
            )}
            {/* PATROL stars — on touch only shown once you actually have heat
                (saves column space for the guide on a fresh save) */}
            {(!isTouch || hud.heatStars > 0) && (
            <div className={`hud-panel flex flex-col items-end gap-1 ${isTouch ? 'px-2 py-1' : ''} ${hud.heatStars > 0 ? 'border-red-500/70 shadow-[0_0_18px_rgba(255,50,80,0.4)]' : ''}`}>
              <div className="flex gap-1 items-center">
                <span className={`text-slate-400 mr-1 tracking-widest ${isTouch ? 'text-[10px]' : 'text-xs'}`}>PATROL</span>
                {[1, 2, 3, 4, 5].map((i) => (
                  <span key={i} className={`${isTouch ? 'text-xs' : 'text-base'} ${hud.heat >= i ? 'text-red-500 drop-shadow-[0_0_6px_rgba(255,50,80,0.9)]' : 'text-slate-700'}`}>★</span>
                ))}
              </div>
              {hud.heatStars > 0 && !(isTouch && hud.bustedProgress > 0.08) && (
                <div className={`nc-patrol-cap text-xs text-red-200 text-right leading-snug ${isTouch ? 'max-w-[9.5rem] text-[11px]' : 'max-w-[13rem]'}`}>
                  {hud.bustedProgress > 0.25 ? (
                    <span className="text-red-400 font-bold animate-pulse text-[13px]">
                      {isTouch ? '⚠ MASH THE BUTTON!' : <>⚠ GRABBED — MASH <span className="key-cap key-cap-amber" style={{ animationDuration: '0.4s' }}>SPACE</span> to break free!</>}
                    </span>
                  ) : hud.bustedProgress > 0.08 ? (
                    <span className="text-red-400 font-bold animate-pulse text-[13px]">
                      ⚠ DON'T STOP — floor it or they'll box you in!
                    </span>
                  ) : hud.pursued ? (
                    <span className="text-amber-300 font-bold text-[13px]">
                      {isTouch ? '★ CHASED — tap NITRO to boost and keep driving!' : <>★ CHASED — you're faster: hold <span className="key-cap key-cap-amber">SHIFT</span> and keep driving to shake them!</>}
                    </span>
                  ) : (
                    <span>EVADE — keep 60m+ from patrol drones until the stars fade</span>
                  )}
                </div>
              )}
            </div>
            )}
            {!isTouch && (
              <div className="hud-panel text-xs text-slate-400">
                Shards <span className="text-cyan-300 font-bold">{hud.shards}/{hud.totalShards}</span>
              </div>
            )}
          </div>

          {/* touch toasts — slim left-edge chips under the cash/level chips
              (notification style), latest 2, never behind the pedals */}
          {isTouch && toasts.length > 0 && (
            <div className="nc-toasts absolute z-20 flex flex-col items-start gap-1 pointer-events-none">
              {toasts.slice(-2).map((t) => (
                <div key={t.id} className={`toast toast-feed toast-${t.kind}`}>
                  <span className="toast-tag">[{t.kind === 'cash' ? 'PAYOUT' : t.kind === 'warn' ? 'ALERT' : t.kind === 'good' ? 'HARBOR RADIO' : 'DISPATCH'}]</span>
                  <span>{t.msg}</span>
                </div>
              ))}
            </div>
          )}

          {/* bottom-left: desktop speed panel (mobile: joystick owns this corner, speed sits bottom-right) */}
          {!isTouch && (
            <div className="absolute left-4 bottom-4 z-20">
              <div className="hud-panel">
                <div className="text-4xl font-black text-white font-mono">{hud.speedKmh}<span className="text-base text-slate-400 font-normal"> km/h</span></div>
                <div className="w-48 h-2 bg-slate-800 rounded mt-2">
                  <div className={`h-full rounded ${hud.boosting ? 'bg-fuchsia-400 shadow-[0_0_12px_rgba(232,121,249,0.9)]' : 'bg-cyan-500'}`} style={{ width: `${hud.boost}%` }} />
                </div>
                <div className="text-[10px] text-slate-400 mt-1">NITRO — hold SHIFT{hud.drift > 0 && <span className="text-yellow-300 ml-2">DRIFT {hud.drift}</span>}</div>
                {/* Street Cred chain pill: unbanked cred, multiplier, bank timer */}
                {hud.cred && (
                  <div className="mt-1.5">
                    <div className="text-xs font-black text-amber-300 tracking-widest">
                      CRED {hud.cred.chain} <span className="text-fuchsia-300">×{hud.cred.mult}</span>
                    </div>
                    <div className="w-48 h-1 bg-slate-800 rounded mt-0.5">
                      <div className="h-full rounded bg-amber-400 transition-none" style={{ width: `${hud.cred.idle01 * 100}%` }} />
                    </div>
                  </div>
                )}
                {hud.damage > 15 && (
                  <div className="mt-1.5">
                    <div className="w-48 h-1.5 bg-slate-800 rounded">
                      <div className={`h-full rounded ${hud.damage > 80 ? 'bg-red-500' : hud.damage > 50 ? 'bg-amber-400' : 'bg-slate-400'}`} style={{ width: `${hud.damage}%` }} />
                    </div>
                    <div className={`text-[10px] mt-0.5 ${hud.damage > 80 ? 'text-red-400 font-bold' : 'text-amber-300'}`}>🔧 BODY {hud.damage}% — repair at the garage</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* mobile: compact odometer speed just above the joystick — the digits
              roll like a mechanical counter; slim nitro line underneath */}
          {isTouch && (
            <div
              className="nc-odo absolute left-4 z-20 flex flex-col items-start gap-0.5 pointer-events-none"
            >
              <div className="flex items-baseline gap-1">
                <SpeedDigits value={hud.speedKmh} boosting={hud.boosting} />
                <span className="text-[9px] text-slate-300/90 tracking-[0.25em] font-semibold">KM/H</span>
              </div>
              <div className="w-24 h-1 bg-white/10 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${hud.boosting ? 'bg-fuchsia-400 shadow-[0_0_10px_rgba(232,121,249,0.9)]' : hud.boost >= 95 ? 'bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.8)]' : 'bg-cyan-500/80'}`}
                  style={{ width: `${hud.boost}%` }}
                />
              </div>
              {hud.drift > 0 && <div className="text-yellow-300 text-[11px] font-black drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]">DRIFT +{hud.drift}</div>}
              {/* Street Cred chain pill (mobile): same info, one slim line */}
              {hud.cred && (
                <>
                  <div className="text-[11px] font-black text-amber-300 drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)] tracking-widest">
                    CRED {hud.cred.chain} <span className="text-fuchsia-300">×{hud.cred.mult}</span>
                  </div>
                  <div className="w-24 h-0.5 bg-white/10 rounded-full overflow-hidden">
                    <div className="h-full bg-amber-400" style={{ width: `${hud.cred.idle01 * 100}%` }} />
                  </div>
                </>
              )}
              {hud.damage > 15 && (
                <div className="flex items-center gap-1 pointer-events-none">
                  <span className="text-[10px]">🔧</span>
                  <div className="w-16 h-1 bg-white/10 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${hud.damage > 80 ? 'bg-red-500' : 'bg-amber-400'}`} style={{ width: `${hud.damage}%` }} />
                  </div>
                  <span className={`text-[9px] font-bold drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] ${hud.damage > 80 ? 'text-red-400' : 'text-amber-300'}`}>{hud.damage}%</span>
                </div>
              )}
            </div>
          )}

          {/* bottom-right: keyboard hints (desktop only) */}
          {!isTouch && (
            <div className="absolute bottom-4 right-4 z-20 hud-panel text-[11px] text-slate-400 leading-relaxed">
              <b className="text-slate-200">WASD</b> drive · <b className="text-slate-200">SHIFT</b> nitro · <b className="text-slate-200">SPACE</b> handbrake · <b className="text-slate-200">R</b> unstuck<br />
              <b className="text-slate-200">E</b> job board · <b className="text-slate-200">H</b> horn · <b className="text-slate-200">C</b> camera · <b className="text-slate-200">M</b> map · <b className="text-slate-200">ESC</b> menu
            </div>
          )}

          {/* ======== TOUCH CONTROLS (mobile / tablet) ========
              Two schemes: virtual joystick (default) or classic buttons */}
          {isTouch && (!overlay || overlay === 'map') && save.controls !== 'buttons' && (
            <div className="absolute inset-0 z-30 pointer-events-none">
              <div
                className="touch-cluster absolute inset-x-0 bottom-0 flex justify-between items-end gap-3 px-3 sm:px-4"
              >
                {/* virtual joystick: push forward = gas, side = steer, back = brake */}
                <div className="pointer-events-auto">
                  <Joystick engine={engineRef.current} />
                </div>
                {/* actions + nitro/drift/brake */}
                <div className="flex flex-col items-end gap-2 pointer-events-auto">
                  <div className="flex items-end gap-2">
                    <TouchBtn engine={engineRef.current} label={<IcoDrift />} aria="Drift" hold=" " variant="drift" />
                    <TouchBtn engine={engineRef.current} label={<IcoBolt />} aria="Nitro" hold="shift" variant="nitro" ready={hud.boost >= 95} lit={hud.boosting} />
                    <TouchBtn engine={engineRef.current} label={<IcoBrake />} aria="Brake" hold="s" variant="pedal" />
                  </div>
                </div>
              </div>
              {/* big mash button when the Patrol grabs the car */}
              {hud.bustedProgress > 0.2 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-auto">
                  <TouchBtn engine={engineRef.current} label={<><IcoMash /><span className="text-[9px] tracking-[0.2em] font-black mt-0.5">MASH</span></>} aria="Mash to break free" tap=" " mash />
                </div>
              )}
            </div>
          )}

          {/* CoD-style swipe steering — right half of the screen is a drag surface.
              Only for the joystick scheme; sits under the buttons so button
              touches never steer. */}
          {isTouch && (!overlay || overlay === 'map') && save.controls !== 'buttons' && !photoMode && (
            <SwipeSteerZone engine={engineRef.current} enabled />
          )}

          {/* classic button scheme (opt-in from the pause menu) */}
          {isTouch && (!overlay || overlay === 'map') && save.controls === 'buttons' && (
            <div className="absolute inset-0 z-30 pointer-events-none">
              <div
                className="touch-cluster absolute inset-x-0 bottom-0 flex justify-between items-end gap-3 px-3 sm:px-4"
              >
                {/* steering */}
                <div className="flex gap-3 pointer-events-auto">
                  <TouchBtn engine={engineRef.current} label="◀" hold="a" />
                  <TouchBtn engine={engineRef.current} label="▶" hold="d" />
                </div>
                {/* actions (top-right) + pedals (2x2 grid, bottom-right) */}
                <div className="flex flex-col items-end gap-2 pointer-events-auto">
                  <div className="flex items-end gap-2">
                    <div className="flex flex-col gap-2">
                      <TouchBtn engine={engineRef.current} label={<IcoBolt />} aria="Nitro" hold="shift" variant="nitro" ready={hud.boost >= 95} lit={hud.boosting} />
                      <TouchBtn engine={engineRef.current} label={<IcoDrift />} aria="Drift" hold=" " variant="drift" />
                    </div>
                    <div className="flex flex-col gap-2">
                      <TouchBtn engine={engineRef.current} label="▲" hold="w" variant="pedal" tall />
                      <TouchBtn engine={engineRef.current} label="▼" hold="s" variant="pedal" />
                    </div>
                  </div>
                </div>
              </div>
              {/* big mash button when the Patrol grabs the car */}
              {hud.bustedProgress > 0.2 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-auto">
                  <TouchBtn engine={engineRef.current} label={<><IcoMash /><span className="text-[9px] tracking-[0.2em] font-black mt-0.5">MASH</span></>} aria="Mash to break free" tap=" " mash />
                </div>
              )}
            </div>
          )}

          {/* pause — top CENTER on mobile (CoD-style), keyboard ESC on desktop */}
          {isTouch && !hostPaused && (
            <button
              onClick={() => setOverlay(overlay === 'pause' ? null : 'pause')}
              className="touch-btn touch-btn-sm absolute top-2 left-1/2 -translate-x-1/2 z-30"
              aria-label="Pause"
            >
              <IcoPause />
            </button>
          )}

          {/* ACTION MODE — red edge vignette on every platform; the text banner
              itself is desktop-only (mobile gets the pinned pill in the
              right-side notification column, so nothing blocks the drive view). */}
          {hud.pursued && !hud.busted && !overlay && (
            <>
              <div
                className="absolute inset-0 z-10 pointer-events-none animate-pulse"
                style={{ boxShadow: 'inset 0 0 80px rgba(255,30,60,0.35)' }}
              />
              {!isTouch && (
                <div
                  className="absolute top-3 left-1/2 -translate-x-1/2 z-30 pointer-events-none px-4 py-1.5 rounded-md border border-red-500/80 bg-red-950/70 backdrop-blur-sm text-red-300 font-black tracking-[0.25em] text-xs sm:text-sm animate-pulse"
                >
                  ⚠ ACTION MODE ON — SAVE YOURSELF
                </div>
              )}
            </>
          )}

          {/* E prompt — job board at the garage / contract at a beacon */}
          {!overlay && !isTouch && hud.nearGarage && (
            <div className="nh-prompt absolute bottom-24 left-1/2 -translate-x-1/2 z-20 px-4 py-2.5 bg-cyan-500/20 border border-cyan-400 rounded text-cyan-100 text-base animate-pulse">
              Press <span className="key-cap">E</span> — open the Job Board
            </div>
          )}
          {!overlay && !isTouch && !hud.nearGarage && hud.marker && (
            <div className={`nh-prompt absolute bottom-24 left-1/2 -translate-x-1/2 z-20 px-4 py-2.5 bg-white/10 border rounded text-base animate-pulse ${JOB_BORDER_CLS[hud.marker.kind] ?? 'border-cyan-400'} ${JOB_TEXT_CLS[hud.marker.kind] ?? 'text-cyan-100'}`}>
              Press <span className="key-cap">E</span> — take the {JOB_LABEL[hud.marker.kind] ?? 'contract'}
            </div>
          )}

          {/* stuck recovery is fully automatic: the engine detects a wedged car
              and respawns it on the road with a toast. The only manual affordance
              is the small RESET touch button (mobile) / R key (desktop) — no
              center-screen banner interrupting the drive. */}

          {/* build badge — version + git hash, ALWAYS visible (tiny, corner):
              this is how anyone testing on any device proves which build they
              are actually running. If the hash doesn't match the latest
              deploy, the phone is showing a stale cached page. */}
          <div className={`absolute z-10 text-[9px] tracking-[0.25em] text-slate-500 pointer-events-none ${isTouch ? 'bottom-0.5 left-1' : 'bottom-1 left-1/2 -translate-x-1/2 text-[10px] tracking-[0.4em] text-slate-600'}`}>
            {GAME_VERSION} · {BUILD_HASH}{isTouch ? '' : ' — progress is saved locally'}
          </div>

          {/* busted flash + what-to-do summary */}
          {bustedFlash && (
            <div className="absolute inset-0 z-30 bg-red-950/50 flex items-center justify-center pointer-events-none">
              <div className="text-center busted-anim">
                <div className="text-6xl font-black text-red-400 tracking-[0.3em]">BUSTED</div>
                <div className="mt-3 text-slate-200 text-sm max-w-sm mx-auto leading-relaxed">
                  The Patrol hauled you back to the garage and fined 15% of your cash.<br />
                  <span className="text-cyan-300">
                    {isTouch
                      ? 'Next time: when a drone grabs you, MASH the DRIFT button rapidly to break free — and never stop moving.'
                      : 'Next time: when a drone grabs you, MASH SPACE to break free — and never stop moving.'}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* WRECKED — explosion flash, then the game-over tow card */}
          {wreckFlash && (
            <div className="absolute inset-0 z-30 bg-orange-500/30 pointer-events-none" />
          )}
          {hud?.wrecked && (
            <div className="absolute inset-0 z-40 bg-black/60 flex items-center justify-center">
              <div className="text-center busted-anim px-6">
                <div className="text-6xl font-black text-orange-400 tracking-[0.3em] drop-shadow-[0_0_24px_rgba(255,122,26,0.8)]">WRECKED</div>
                <div className="mt-3 text-slate-200 text-sm max-w-sm mx-auto leading-relaxed">
                  She took too much and went up in flames. The tow truck drags her back to the garage — patched up enough to limp, but she needs real repairs.
                </div>
                <button
                  onClick={() => {
                    engineRef.current?.towToGarage()
                    setSave({ ...saveRef.current })
                  }}
                  className="mt-5 px-6 py-3 text-sm font-black border border-orange-400 text-orange-200 rounded-xl hover:bg-orange-400/20 tracking-widest"
                >
                  🚛 {save.stats.tows === 0 ? 'TOW TO GARAGE — FREE (first one)' : 'TOW TO GARAGE — $150'}
                </button>
              </div>
            </div>
          )}

          {/* mission-complete result banner — DESKTOP center-top. On mobile it
              lives in the right-side notification column (with photo + ✕). */}
          {winBanner && !overlay && !photoMode && !isTouch && (
            <div className="absolute left-1/2 -translate-x-1/2 z-30 pointer-events-auto top-24">
              <div className="hud-panel border-emerald-400/70 shadow-[0_0_28px_rgba(52,211,153,0.35)] flex items-center gap-3 px-4 py-2.5">
                <div>
                  <div className="text-[10px] tracking-[0.25em] text-emerald-300">MISSION COMPLETE</div>
                  <div className="text-white font-bold text-sm leading-tight">{winBanner.name} <span className="text-emerald-400">+${winBanner.reward}</span></div>
                </div>
                <button
                  onClick={() => { setWinBanner(null); togglePhoto() }}
                  className="touch-btn touch-btn-sm shrink-0"
                  aria-label="Photo mode"
                >
                  <IcoCam />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ================= FIRST-RUN ONBOARDING (once per device) =================
          Touch: strategy-game style — a cartoon hand SHOWS each action over the
          live controls and the step advances when the player actually DOES it:
          push joystick → swipe to steer → tap nitro → follow the beam.
          Desktop: short card flow with key caps. */}
      {screen === 'game' && onboardStep !== null && (
        <div className="absolute inset-0 z-40 pointer-events-none select-none">
          {/* dim layer — controls stay live beneath (pointer-events none) */}
          {(isTouch ? onboardStep >= 1 && onboardStep <= 3 : onboardStep > 0 && onboardStep < 4) && (
            <div className="absolute inset-0 onboard-dim" />
          )}
          {/* spotlight rings over the live controls */}
          {onboardStep === 1 && (
            <div
              className="spotlight"
              style={
                isTouch
                  ? { left: '0.35rem', bottom: '2.7rem', width: '8.6rem', height: '8.6rem', borderRadius: '9999px' }
                  : { left: '0.6rem', bottom: '0.6rem', width: '9.6rem', height: '9.6rem', borderRadius: '9999px' }
              }
            />
          )}
          {((isTouch && onboardStep === 3) || (!isTouch && onboardStep === 2)) && (
            <div
              className="spotlight"
              style={
                isTouch
                  ? { right: '0.35rem', bottom: '2.9rem', width: '13.8rem', height: '5.4rem', borderRadius: '1.2rem' }
                  : { right: '0.6rem', bottom: '0.6rem', width: '12rem', height: '6rem', borderRadius: '1.2rem' }
              }
            />
          )}

          {/* step 0 — welcome (both platforms) */}
          {onboardStep === 0 && (
            <div className="onboard-card">
              <div className="text-[11px] tracking-[0.35em] text-cyan-300 font-bold">WELCOME TO</div>
              <div className="text-3xl font-black text-white tracking-wide mt-1">NEON HARBOR</div>
              <div className="text-slate-300 text-sm mt-2 leading-relaxed">
                One city. One night. Your legend.<br />Drive, earn, unlock — and don't stop when the patrol shows up.
              </div>
              <div className="flex gap-2 mt-4 text-[11px] font-bold text-slate-200">
                <span className="px-2.5 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-400/40">JOBS &amp; RACES</span>
                <span className="px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-400/40">PATROL CHASES</span>
                <span className="px-2.5 py-1.5 rounded-lg bg-fuchsia-500/10 border border-fuchsia-400/40">24 SHARDS</span>
              </div>
              <button className="onboard-next mt-5" onClick={() => setOnboardStep(1)}>LET'S RIDE →</button>
            </div>
          )}

          {/* ================= TOUCH FLOW — show, don't tell ================= */}

          {/* touch step 1 — hand on the joystick: PUSH UP = DRIVE */}
          {isTouch && onboardStep === 1 && (
            <>
              <GuideHand variant="push" style={{ left: '2.85rem', bottom: '5rem' }} />
              <div className={`gchip${(hud?.speedKmh ?? 0) > 8 ? ' gchip-done' : ''}`} style={{ left: '1rem', bottom: '12.3rem' }}>
                {(hud?.speedKmh ?? 0) > 8 ? '✓ GO!' : 'PUSH UP — DRIVE'}
              </div>
              {obFallback && (
                <button className="gskip" style={{ left: '50%', transform: 'translateX(-50%)', bottom: '1.2rem' }} onClick={() => setOnboardStep(2)}>
                  SKIP →
                </button>
              )}
            </>
          )}

          {/* touch step 2 — hand swipes the right half: SWIPE = STEER */}
          {isTouch && onboardStep === 2 && (
            <>
              <GuideHand variant="swipe" style={{ right: '16%', top: '38%' }} />
              <div className="gchip" style={{ right: '9%', top: '30%' }}>SWIPE — STEER</div>
              {obFallback && (
                <button className="gskip" style={{ left: '50%', transform: 'translateX(-50%)', bottom: '1.2rem' }} onClick={() => setOnboardStep(3)}>
                  SKIP →
                </button>
              )}
            </>
          )}

          {/* touch step 3 — hand taps the nitro bolt: TAP = BOOST */}
          {isTouch && onboardStep === 3 && (
            <>
              <GuideHand variant="tap" style={{ right: '5.6rem', bottom: '5.4rem' }} />
              <div className={`gchip gchip-fuchsia${hud && (hud.boosting || hud.boost < 95) ? ' gchip-done' : ''}`} style={{ right: '1rem', bottom: '12.3rem' }}>
                {hud && (hud.boosting || hud.boost < 95) ? '✓ BOOM!' : 'TAP ⚡ — NITRO'}
              </div>
              <div className="gchip" style={{ right: '1rem', bottom: '15.4rem', opacity: 0.85, fontSize: '0.68rem' }}>
                DRIFT SLIDES REFILL IT
              </div>
              {obFallback && (
                <button className="gskip" style={{ left: '50%', transform: 'translateX(-50%)', bottom: '1.2rem' }} onClick={() => setOnboardStep(4)}>
                  SKIP →
                </button>
              )}
            </>
          )}

          {/* touch step 4 — the objective, while driving: beam = work */}
          {isTouch && onboardStep === 4 && (
            <>
              <div className="gchip" style={{ left: '0.9rem', top: '3.1rem' }}>
                <span className="gbeam" /> BEAM = WORK
              </div>
              <GuideHand variant="point" style={{ left: '46%', top: '18%' }} />
              {hud?.nearGarage && (
                <div className="gchip gchip-done" style={{ left: '50%', transform: 'translateX(-50%)', bottom: '9.5rem' }}>
                  ✓ THAT'S THE SPOT
                </div>
              )}
              {obFallback && (
                <button className="gskip" style={{ left: '50%', transform: 'translateX(-50%)', bottom: '1.2rem' }} onClick={() => setOnboardStep(5)}>
                  NEXT →
                </button>
              )}
            </>
          )}

          {/* touch step 5 — ready: full control handed over */}
          {isTouch && onboardStep === 5 && (
            <div className="onboard-card items-center">
              <div className="text-2xl font-black text-white tracking-wide">READY?</div>
              <div className="text-slate-300 text-sm mt-1 text-center">
                Follow the beam. Take the job.<br />The FIRST NIGHT guide rides with you, live.
              </div>
              <button
                className="onboard-next onboard-start mt-5"
                onClick={() => {
                  try { window.localStorage.setItem(ONBOARD_KEY, '1') } catch { /* ignore */ }
                  setOnboardStep(null)
                }}
              >
                TAP TO START
              </button>
            </div>
          )}

          {/* ================= DESKTOP FLOW — key-cap cards ================= */}

          {/* desktop step 1 — drive */}
          {!isTouch && onboardStep === 1 && (
            <div className="onboard-card onboard-card-low">
              <div className="text-[11px] tracking-[0.3em] text-cyan-300 font-bold">YOUR WHEEL</div>
              <div className="text-white font-bold mt-1 text-sm leading-snug">
                Hold <span className="key-cap">W</span> to speed up, steer with <span className="key-cap">A</span>/<span className="key-cap">D</span> — try it!
              </div>
              <button className="onboard-next mt-3" onClick={() => setOnboardStep(2)}>GOT IT →</button>
            </div>
          )}

          {/* desktop step 2 — power keys */}
          {!isTouch && onboardStep === 2 && (
            <div className="onboard-card onboard-card-low">
              <div className="text-[11px] tracking-[0.3em] text-cyan-300 font-bold">POWER KEYS</div>
              <div className="mt-2 space-y-1.5 text-left">
                <div className="flex items-center gap-2.5 text-slate-200 text-sm">
                  <span className="onboard-ico text-fuchsia-300"><IcoBolt /></span>
                  <span><b className="text-white">NITRO</b> — hold <span className="key-cap">SHIFT</span> for a burst of speed. Drifting refills it.</span>
                </div>
                <div className="flex items-center gap-2.5 text-slate-200 text-sm">
                  <span className="onboard-ico text-amber-300"><IcoDrift /></span>
                  <span><b className="text-white">DRIFT</b> — hold <span className="key-cap">SPACE</span> while turning to slide. Builds nitro.</span>
                </div>
                <div className="flex items-center gap-2.5 text-slate-200 text-sm">
                  <span className="onboard-ico text-sky-300"><IcoBrake /></span>
                  <span><b className="text-white">BRAKE</b> — hold <span className="key-cap">S</span> to stop hard and swing the car around.</span>
                </div>
              </div>
              <button className="onboard-next mt-3" onClick={() => setOnboardStep(3)}>GOT IT →</button>
            </div>
          )}

          {/* desktop step 3 — your goal */}
          {!isTouch && onboardStep === 3 && (
            <div className="onboard-card">
              <div className="text-[11px] tracking-[0.3em] text-cyan-300 font-bold">YOUR GOAL</div>
              <div className="text-slate-200 text-sm mt-2 leading-relaxed text-left">
                • Take <b className="text-cyan-300">jobs</b> at the glowing garage beam — earn cash, level up<br />
                • Locked districts open as you <b className="text-amber-300">level up</b><br />
                • <b className="text-fuchsia-300">Map icon</b> = tactical view · pause sits top-center<br />
                • If the <b className="text-red-400">PATROL ★</b> light up… <b className="text-red-300">don't stop</b>
              </div>
              <button className="onboard-next mt-4" onClick={() => setOnboardStep(4)}>ALMOST THERE →</button>
            </div>
          )}

          {/* desktop step 4 — ready */}
          {!isTouch && onboardStep === 4 && (
            <div className="onboard-card items-center">
              <div className="text-2xl font-black text-white tracking-wide">READY?</div>
              <div className="text-slate-300 text-sm mt-1">The FIRST NIGHT guide will walk you through it, live.</div>
              <button
                className="onboard-next onboard-start mt-5"
                onClick={() => {
                  try { window.localStorage.setItem(ONBOARD_KEY, '1') } catch { /* ignore */ }
                  setOnboardStep(null)
                }}
              >
                CLICK TO START
              </button>
            </div>
          )}
        </div>
      )}

      {/* ================= PHOTO MODE ================= */}
      {screen === 'game' && photoMode && (
        <div className="absolute inset-0 z-30 pointer-events-none">
          <div className="absolute top-4 left-1/2 -translate-x-1/2 hud-panel text-[11px] text-slate-300 text-center">
            📸 PHOTO MODE — {isTouch ? 'drag to orbit' : 'drag to orbit · scroll to zoom'} · world is frozen
          </div>
          <div
            className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 pointer-events-auto"
            style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
          >
            <button
              onClick={() => setPhotoFilter((f) => (f + 1) % PHOTO_FILTERS.length)}
              className="px-4 py-3 rounded-xl bg-slate-900/70 border border-cyan-500/50 text-cyan-200 text-xs font-bold tracking-widest hover:bg-slate-800/80"
            >
              FILTER: {PHOTO_FILTERS[photoFilter].name}
            </button>
            <button
              onClick={savePhoto}
              className="px-5 py-3 rounded-xl bg-cyan-500/25 border border-cyan-400 text-cyan-100 text-xs font-black tracking-widest hover:bg-cyan-400/35"
            >
              ⬇ SAVE
            </button>
            <button
              onClick={togglePhoto}
              className="px-4 py-3 rounded-xl bg-slate-900/70 border border-slate-600 text-slate-300 text-xs font-bold tracking-widest hover:bg-slate-800/80"
            >
              EXIT {isTouch ? '' : '(P)'}
            </button>
          </div>
        </div>
      )}

      {/* ================= PAUSE ================= */}
      {screen === 'game' && overlay === 'pause' && (
        <div
          className="absolute inset-0 z-40 bg-black/70 backdrop-blur-sm pause-overlay"
          onClick={() => setOverlay(null)} /* tap the dimmed background to resume */
        >
          <h2 className="text-4xl font-black text-white tracking-[0.3em] mb-8 shrink-0">PAUSED</h2>
          <div className="flex flex-col gap-3 w-64 shrink-0 menu-col" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setOverlay(null)} className="menu-btn menu-btn-primary btn-attend">RESUME</button>
            <button onClick={() => setOverlay('shop')} className="menu-btn">GARAGE SHOP</button>
            <button onClick={() => setOverlay('help')} className="menu-btn">HOW TO PLAY</button>
            <button
              onClick={() => {
                // Full FTUE replay: clears both gates (tap-through onboarding
                // flag + in-game FIRST NIGHT tutorial) so every hand-guided
                // step can be re-verified on demand — QA shortcut.
                try { window.localStorage.removeItem(ONBOARD_KEY) } catch { /* ignore */ }
                saveRef.current.tutorialDone = false
                commit()
                setTutorialHidden(false)
                setObFallback(false)
                setOnboardStep(0)
                setOverlay(null)
              }}
              className="menu-btn"
            >
              REPLAY TUTORIAL
            </button>
            <button onClick={toggleMute} className="menu-btn">{save.muted ? 'UNMUTE' : 'MUTE'}</button>
            <button onClick={toggleCycle} className="menu-btn">ENVIRONMENT CYCLE: {save.autoCycle ? 'ON' : 'OFF'}</button>
            {isTouch && (
              <button onClick={toggleControls} className="menu-btn">CONTROLS: {save.controls === 'joystick' ? 'JOYSTICK' : 'BUTTONS'}</button>
            )}
            <button onClick={exportSave} className="menu-btn">EXPORT SAVE</button>
            <button onClick={() => fileRef.current?.click()} className="menu-btn">IMPORT SAVE</button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) importSaveFile(f)
                e.target.value = ''
              }}
            />
            <button onClick={quitToMenu} className="menu-btn">QUIT TO MENU</button>
            <div className="text-center text-[10px] tracking-[0.2em] text-slate-500 pt-1 select-none">
              {GAME_VERSION} · build {BUILD_HASH} · {BUILD_TIME}
            </div>
          </div>
        </div>
      )}

      {/* Host-requested pause (vplay.gg) — tap to resume */}
      {screen === 'game' && hostPaused && (
        <button
          onClick={() => {
            setHostPaused(false)
            engineRef.current?.setPaused(false)
            engineRef.current?.resumeAudio()
            VPlay.gameplayStart()
          }}
          className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm cursor-pointer"
        >
          <h2 className="text-3xl font-black text-white tracking-[0.3em] mb-3">PAUSED</h2>
          <p className="text-cyan-300 text-sm tracking-widest animate-pulse">TAP TO CONTINUE</p>
        </button>
      )}

      {/* ================= CITY MAP (CoD Mobile pattern) =================
          Tap the minimap (or the map icon) to expand. Touch: a large RIGHT-side
          panel — the game keeps running behind it and the map redraws live, so
          you can navigate while driving. Desktop: fullscreen modal (pauses). */}
      {overlay === 'map' && screen === 'game' && (
        isTouch ? (
          <div className="absolute inset-0 z-40 pointer-events-none">
            <div
              className="absolute right-2 top-2 pointer-events-auto rounded-xl border border-slate-400/60 bg-white/90 shadow-[0_8px_40px_rgba(0,0,0,0.45)] overflow-hidden"
              style={{ width: 'min(56vw, 72vh)' }}
            >
              <div className="flex items-center justify-between px-2 py-1 bg-slate-100/90 border-b border-slate-300">
                <span className="text-[10px] tracking-[0.25em] text-slate-600 font-bold">CITY MAP</span>
                <button
                  onClick={() => setOverlay(null)}
                  className="text-slate-500 hover:text-slate-900 text-base leading-none px-1"
                  aria-label="Close map"
                >
                  ✕
                </button>
              </div>
              <canvas ref={tacMapRef} className="block w-full" style={{ aspectRatio: '1 / 1' }} />
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/80 backdrop-blur-sm">
            <div className="relative flex items-center justify-center w-full h-full p-3 sm:p-6">
              <canvas
                ref={tacMapRef}
                className="rounded-xl border border-slate-600/80 shadow-[0_0_60px_rgba(34,211,238,0.15)]"
                style={{ width: 'min(94vw, 86vh)', height: 'min(94vw, 86vh)' }}
              />
              <button
                onClick={() => setOverlay(null)}
                className="absolute top-3 right-3 sm:top-5 sm:right-5 w-10 h-10 rounded-full bg-slate-900/80 border border-slate-600 text-slate-300 hover:text-white text-xl"
                aria-label="Close map"
              >
                ✕
              </button>
            </div>
          </div>
        )
      )}

      {/* ================= PROGRESS (trophies + districts) ================= */}
      {overlay === 'progress' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[42rem] max-w-[92vw] max-h-[80vh] overflow-y-auto bg-slate-900/90 border border-cyan-500/30 rounded-2xl p-6 shadow-[0_0_60px_rgba(34,211,238,0.15)]">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-2xl font-black text-white tracking-widest">YOUR LEGEND</h2>
              <button onClick={() => setOverlay(null)} className="text-slate-400 hover:text-white text-xl">✕</button>
            </div>
            <div className="flex gap-2 mb-4">
              <button onClick={() => setProgressTab('trophies')} className={`shop-tab ${progressTab === 'trophies' ? 'shop-tab-on' : ''}`}>TROPHIES</button>
              <button onClick={() => setProgressTab('districts')} className={`shop-tab ${progressTab === 'districts' ? 'shop-tab-on' : ''}`}>DISTRICTS</button>
            </div>
            {progressTab === 'trophies' && (
              <>
                <div className="text-xs text-slate-400 mb-3">
                  {save.achievements.length}/{ACHIEVEMENTS.length} unlocked — each trophy pays a $150 bonus
                </div>
                <div className="grid sm:grid-cols-2 gap-2">
                  {ACHIEVEMENTS.map((a) => {
                    const got = save.achievements.includes(a.id)
                    return (
                      <div key={a.id} className={`rounded-lg border p-3 ${got ? 'border-amber-400/60 bg-amber-400/10' : 'border-slate-700 bg-slate-800/40 opacity-55'}`}>
                        <div className="flex items-center gap-2">
                          <span className="text-xl">{got ? a.icon : '🔒'}</span>
                          <span className={`font-bold text-sm ${got ? 'text-amber-300' : 'text-slate-400'}`}>{a.name}</span>
                        </div>
                        <div className="text-[11px] text-slate-400 mt-1">{a.desc}</div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
            {progressTab === 'districts' && (
              <>
                <div className="text-xs text-slate-400 mb-3">
                  Explore all five districts — each first visit pays a $100 discovery bonus
                </div>
                <div className="flex flex-col gap-2">
                  {DISTRICTS.map((d) => {
                    const visited = save.districts.includes(d.id)
                    const locked = save.level < d.minLevel
                    return (
                      <div key={d.id} className={`rounded-lg border p-3 flex items-center justify-between ${visited ? 'border-cyan-400/60 bg-cyan-400/10' : locked ? 'border-slate-700 bg-slate-800/40 opacity-55' : 'border-slate-600 bg-slate-800/60'}`}>
                        <div>
                          <div className={`font-bold text-sm ${visited ? 'text-cyan-300' : 'text-slate-200'}`}>
                            {d.name} {visited && <span className="text-[10px] text-emerald-400 ml-1">✓ VISITED</span>}
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5">{d.desc}</div>
                        </div>
                        <div className="text-[11px] font-bold text-right">
                          {locked ? <span className="text-red-400">LV {d.minLevel}</span> : <span className="text-emerald-400">OPEN</span>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ================= JOB BOARD ================= */}
      {screen === 'game' && overlay === 'jobs' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[42rem] max-w-[92vw] bg-slate-900/90 border border-cyan-500/30 rounded-2xl p-6 shadow-[0_0_60px_rgba(34,211,238,0.15)]">
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-2xl font-black text-white tracking-widest">JOB BOARD</h2>
              <button onClick={() => setOverlay(null)} className="text-slate-400 hover:text-white text-xl">✕</button>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <button
                onClick={() => { engineRef.current?.startMission('delivery'); setOverlay(null) }}
                className="job-card border-cyan-500/40 hover:border-cyan-300"
              >
                <div className="text-3xl mb-2">📦</div>
                <div className="text-lg font-bold text-cyan-300">Courier Run</div>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  Grab the package at the yellow beacon and deliver it before the clock dies. Pay scales with distance and speed.
                </p>
                <div className="text-emerald-400 text-sm font-bold mt-3">~$200–600 + XP</div>
              </button>
              <button
                onClick={() => { engineRef.current?.startMission('race'); setOverlay(null) }}
                className="job-card border-fuchsia-500/40 hover:border-fuchsia-300"
              >
                <div className="text-3xl mb-2">🏁</div>
                <div className="text-lg font-bold text-fuchsia-300">Harbor GP</div>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  8 gates across the city, 14 seconds each. Chain them fast — leftover time is pure profit. Nitro recommended.
                </p>
                <div className="text-emerald-400 text-sm font-bold mt-3">~$380+ + big XP</div>
              </button>
              <button
                onClick={() => { engineRef.current?.startMission('taxi'); setOverlay(null) }}
                className="job-card border-amber-500/40 hover:border-amber-300"
              >
                <div className="text-3xl mb-2">🚕</div>
                <div className="text-lg font-bold text-amber-300">Taxi Fare</div>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  A passenger is waiting at the beacon. Pick them up and get them there fast — the meter pays a speed tip on whatever time is left.
                </p>
                <div className="text-emerald-400 text-sm font-bold mt-3">~$250–550 + XP</div>
              </button>
              <button
                onClick={() => { engineRef.current?.startMission('getaway'); setOverlay(null) }}
                className="job-card border-red-500/40 hover:border-red-300"
              >
                <div className="text-3xl mb-2">🚨</div>
                <div className="text-lg font-bold text-red-300">Getaway Contract</div>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  The Patrol is already hunting you. No timer — just stay free and out of their grasp until the heat bleeds away. Busted means no pay.
                </p>
                <div className="text-emerald-400 text-sm font-bold mt-3">~$700 + big XP</div>
              </button>
            </div>
            {hud?.mission && (
              <button
                onClick={() => { engineRef.current?.cancelMission(); setOverlay(null) }}
                className="mt-4 w-full py-2 border border-red-500/40 text-red-400 rounded hover:bg-red-500/10 text-sm"
              >
                Abandon current job ({hud.mission.name})
              </button>
            )}
          </div>
        </div>
      )}

      {/* ================= SHOP ================= */}
      {overlay === 'shop' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="shop-panel w-[52rem] max-w-[94vw] max-h-[86vh] overflow-y-auto bg-slate-900/95 border border-fuchsia-500/30 rounded-2xl p-6 shadow-[0_0_60px_rgba(232,121,249,0.15)]">
            <h2 className="shop-title text-2xl font-black text-white tracking-widest mb-1">GARAGE SHOP</h2>
            <div className="shop-head flex justify-between items-start mb-4">
              <div className="text-slate-400 text-xs pt-1">
                Balance: <span className="text-emerald-400 font-bold">${save.cash.toLocaleString()}</span> · Level {save.level}
                {vplay?.mode === 'vplay' && (
                  <span className="ml-3">VCoins: <span className="text-amber-300 font-bold">◈ {vcBalance.toLocaleString()}</span></span>
                )}
              </div>
              <button onClick={() => setOverlay(null)} className="text-slate-400 hover:text-white text-xl">✕</button>
            </div>

            {/* Body repair — visible the moment the car has any damage */}
            {hud && hud.damage > 0 && (
              <div className="shop-repair w-full mb-5 p-4 rounded-xl border border-cyan-400/40 bg-cyan-500/10">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="repair-title text-cyan-300 font-black tracking-widest">🔧 BODY REPAIR</div>
                    <div className="repair-bar mt-2 w-56 max-w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${hud.damage > 80 ? 'bg-red-500' : hud.damage > 50 ? 'bg-amber-400' : 'bg-cyan-400'}`} style={{ width: `${hud.damage}%` }} />
                    </div>
                    <div className="repair-desc text-slate-400 text-xs mt-1">Damage {hud.damage}% — a clean body turns heads again</div>
                  </div>
                  <button
                    onClick={() => {
                      engineRef.current?.repair()
                      setSave({ ...saveRef.current })
                    }}
                    disabled={save.cash < (engineRef.current?.repairCost() ?? Infinity)}
                    className="px-4 py-2 text-sm font-black border border-cyan-400 text-cyan-200 rounded-lg hover:bg-cyan-400/20 whitespace-nowrap disabled:opacity-40"
                  >
                    {(engineRef.current?.repairCost() ?? 0) === 0 ? 'REPAIR — FREE' : `REPAIR — $${(engineRef.current?.repairCost() ?? 0).toLocaleString()}`}
                  </button>
                </div>
              </div>
            )}

            {/* Harbor Pass banner */}
            {isOwned(HARBOR_PASS_ID) ? (
              <div className="shop-pass w-full mb-5 p-3 rounded-xl border border-emerald-400/40 bg-emerald-500/10 text-emerald-300 text-sm text-center">
                🔓 HARBOR PASS owned — all premium content unlocked
              </div>
            ) : vplay?.mode === 'vplay' ? (
              <div className="shop-pass w-full mb-5 p-4 rounded-xl border border-amber-400/50 bg-gradient-to-r from-amber-500/15 to-fuchsia-500/15">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="shop-pass-title text-amber-300 font-black tracking-widest">HARBOR PASS</div>
                    <div className="shop-pass-desc text-slate-300 text-xs mt-1">Unlocks all {HARBOR_PASS_ITEMS.length} premium cars and environments (Ghost, Royal, Solar, Oni, Sakura Dusk, Acid Rain) in one go.</div>
                  </div>
                  <button
                    onClick={() => buyVc(HARBOR_PASS_ID, HARBOR_PASS_ID)}
                    disabled={passPrice == null}
                    className="px-4 py-2 text-sm font-black border border-amber-400 text-amber-200 rounded-lg hover:bg-amber-400/20 whitespace-nowrap disabled:opacity-40"
                  >
                    ◈ {passPrice != null ? passPrice.toLocaleString() : '—'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="shop-pass w-full mb-5 p-4 rounded-xl border border-amber-400/50 bg-gradient-to-r from-amber-500/15 to-fuchsia-500/15">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="shop-pass-title text-amber-300 font-black tracking-widest">HARBOR PASS</div>
                    <div className="shop-pass-desc text-slate-300 text-xs mt-1">Unlocks all premium cars and environments with one purchase on vplay.gg.</div>
                  </div>
                  <button
                    onClick={() => VPlay.openOnVplay()}
                    className="px-4 py-2 text-sm font-black border border-amber-400 text-amber-200 rounded-lg hover:bg-amber-400/20 whitespace-nowrap"
                  >
                    UNLOCK ON VPLAY.GG
                  </button>
                </div>
              </div>
            )}

            {/* Tabs */}
            <div className="shop-tabs flex gap-2 mb-4">
              <button onClick={() => setShopTab('skins')} className={`shop-tab ${shopTab === 'skins' ? 'shop-tab-on' : ''}`}>CARS &amp; PAINT</button>
              <button onClick={() => setShopTab('themes')} className={`shop-tab ${shopTab === 'themes' ? 'shop-tab-on' : ''}`}>CITY THEMES</button>
              <button onClick={() => setShopTab('upgrades')} className={`shop-tab ${shopTab === 'upgrades' ? 'shop-tab-on' : ''}`}>UPGRADES</button>
            </div>

            {shopTab === 'upgrades' && (
              <div className="grid md:grid-cols-3 gap-3 mb-1">
                {UPGRADES.map((u) => {
                  const lv = save.upgrades[u.id] ?? 0
                  const maxed = lv >= u.max
                  const price = maxed ? null : u.prices[lv]
                  return (
                    <div key={u.id} className="rounded-xl border border-cyan-400/25 bg-slate-800/70 p-4 flex flex-col">
                      <div className="text-3xl">{u.icon}</div>
                      <div className="text-white font-black tracking-wide mt-2">{u.name}</div>
                      <div className="text-slate-400 text-xs mt-1 flex-1">{u.desc}</div>
                      {/* level pips */}
                      <div className="flex gap-1.5 mt-3">
                        {Array.from({ length: u.max }, (_, i) => (
                          <div key={i} className={`h-1.5 flex-1 rounded-full ${i < lv ? 'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]' : 'bg-slate-700'}`} />
                        ))}
                      </div>
                      <button
                        onClick={() => buyUpgrade(u.id)}
                        disabled={maxed || (price != null && save.cash < price)}
                        className="mt-3 w-full py-2 rounded-lg text-sm font-black border border-emerald-400 text-emerald-300 hover:bg-emerald-400/15 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {maxed ? 'MAXED OUT' : `BUY Lv${lv + 1} — $${price!.toLocaleString()}`}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="grid md:grid-cols-3 gap-3">
              {shopTab === 'skins' && SKINS.map((item: Skin) => (
                <ShopCard
                  key={item.id}
                  name={item.name}
                  desc={item.desc}
                  swatch={item.body}
                  glow={item.glow}
                  price={item.price}
                  premium={item.premium}
                  earned={item.earned}
                  minLevel={item.minLevel}
                  isOwned={owned(item.id)}
                  isEquipped={save.skin === item.id}
                  level={save.level}
                  standalone={vplay?.mode !== 'vplay'}
                  vcPrice={vcPriceOf(item)}
                  onBuy={() => buyItem(item.id, item.price, item.premium, item.minLevel)}
                  onBuyVc={item.vcId ? () => buyVc(item.id, item.vcId!) : undefined}
                  onEquip={() => equipItem(item.id)}
                />
              ))}
              {shopTab === 'themes' && THEMES.map((item: Theme) => (
                <ShopCard
                  key={item.id}
                  name={item.name}
                  desc={item.desc}
                  swatch={item.fog}
                  glow={item.moon}
                  price={item.price}
                  premium={item.premium}
                  minLevel={1}
                  isOwned={owned(item.id)}
                  isEquipped={save.theme === item.id}
                  level={save.level}
                  standalone={vplay?.mode !== 'vplay'}
                  vcPrice={vcPriceOf(item)}
                  preview={<ThemePreview theme={item} />}
                  onBuy={() => buyItem(item.id, item.price, item.premium, 1)}
                  onBuyVc={item.vcId ? () => buyVc(item.id, item.vcId!) : undefined}
                  onEquip={() => equipItem(item.id)}
                />
              ))}
            </div>
            <p className="text-slate-600 text-[11px] mt-5 text-center">
              {vplay?.mode === 'vplay'
                ? 'Green buttons use earned cash · ◈ prices are VCoins — purchases are confirmed by vplay.gg'
                : 'Green buttons use earned cash · Premium items unlock on vplay.gg'}
            </p>
          </div>
        </div>
      )}


      {/* ================= HELP — interactive guide (AAA-style FTUE) ================= */}
      {overlay === 'help' && <HowToPlay isTouch={isTouch} onClose={() => setOverlay(null)} />}

      {/* Mobile portrait: no "rotate your device" wall — the root div above is
          already CSS-rotated into landscape, so the game just launches. */}
    </div>
  )
}

// ---------- Guide hand — the strategy-game style cartoon pointer that
// SHOWS each action over the live controls during the mobile FTUE ----------
function GuideHand({ variant, style }: { variant: 'push' | 'swipe' | 'tap' | 'point'; style?: React.CSSProperties }) {
  return (
    <div className={`ghand ghand-${variant}`} style={style}>
      {variant === 'tap' && <div className="ghand-ripple" />}
      <svg viewBox="0 0 64 64" aria-hidden>
        <rect x="27" y="7" width="10" height="28" rx="5" fill="#f8fafc" stroke="#0f172a" strokeWidth="2.5" />
        <rect x="13" y="33" width="11" height="9" rx="4.5" fill="#f8fafc" stroke="#0f172a" strokeWidth="2.5" />
        <rect x="19" y="28" width="27" height="24" rx="10" fill="#f8fafc" stroke="#0f172a" strokeWidth="2.5" />
        <rect x="20" y="49" width="25" height="11" rx="4" fill="#22d3ee" stroke="#155e75" strokeWidth="2.5" />
      </svg>
    </div>
  )
}

// ---------- On-screen touch button (mobile controls) ----------
function TouchBtn(props: {
  engine: GameEngine | null
  label: React.ReactNode
  aria?: string
  hold?: string // key fed to the engine while pressed
  tap?: string // one-shot action fired on press
  small?: boolean
  wide?: boolean
  tall?: boolean
  mash?: boolean
  variant?: 'nitro' | 'drift' | 'pedal'
  /** nitro state: fully charged (pulses) and/or currently firing (hard glow) */
  ready?: boolean
  lit?: boolean
}) {
  const cls = `touch-btn${props.variant ? ` touch-btn-${props.variant}` : ''}${props.small ? ' touch-btn-sm' : ''}${props.wide ? ' touch-btn-wide' : ''}${props.tall ? ' touch-btn-tall' : ''}${props.mash ? ' touch-btn-mash' : ''}${props.ready && props.variant === 'nitro' ? ' ready' : ''}${props.lit && props.variant === 'nitro' ? ' lit' : ''}`
  const start = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* pointer capture unsupported — hold still works, just drift-sensitive */
    }
    if (!props.engine) return
    if (props.hold) props.engine.touchDown(props.hold)
    if (props.tap) props.engine.touchTap(props.tap)
  }
  const end = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    if (props.engine && props.hold) props.engine.touchUp(props.hold)
  }
  return (
    <button
      className={cls}
      aria-label={props.aria}
      onPointerDown={start}
      onPointerUp={end}
      onPointerLeave={end}
      onPointerCancel={end}
      onContextMenu={(e) => e.preventDefault()}
    >
      {props.label}
    </button>
  )
}

// ---------- Clean white HUD icons (CoD-mobile style — icons, not emoji) ----------
function Ico({ d, children, filled = true }: { d?: string; children?: React.ReactNode; filled?: boolean }) {
  return (
    <svg className="btn-ico" viewBox="0 0 24 24" aria-hidden="true">
      {d && <path d={d} fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />}
      {children}
    </svg>
  )
}
const IcoBolt = () => <Ico d="M13 2 4.6 13.4h5.8L9.6 22l8.4-11.4h-5.8L13 2z" />
const IcoDrift = () => <Ico d="M6.5 3.5c-2.2 5-2.2 12 0 17M12 3.5c-2.2 5-2.2 12 0 17M17.5 3.5c-2.2 5-2.2 12 0 17" filled={false} />
const IcoBrake = () => (
  <Ico>
    <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="2.4" />
    <circle cx="12" cy="12" r="3.1" fill="currentColor" />
  </Ico>
)
const IcoMap = () => <Ico d="M9 3 3 5.4v15.2L9 18.2l6 2.4 6-2.4V3.2L15 5.6 9 3zm0 .2v15m6-12.4v15" filled={false} />
const IcoHorn = () => (
  <Ico>
    <path d="M4 9.2v5.6h3.6L13 19.4V4.6L7.6 9.2H4z" fill="currentColor" />
    <path d="M16.4 8.6a5 5 0 0 1 0 6.8M19 6a8.6 8.6 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </Ico>
)
const IcoPause = () => <Ico d="M7 4.5h3.6v15H7zM13.4 4.5H17v15h-3.6z" />
const IcoCam = () => (
  <Ico>
    <path d="M8.6 6.4 10 4.5h4l1.4 1.9H19a1.6 1.6 0 0 1 1.6 1.6v9.4A1.6 1.6 0 0 1 19 19H5a1.6 1.6 0 0 1-1.6-1.6V8A1.6 1.6 0 0 1 5 6.4h3.6z" fill="currentColor" />
    <circle cx="12" cy="12.6" r="3.6" fill="rgba(6,10,22,0.55)" />
  </Ico>
)
const IcoReset = () => (
  <Ico>
    <path d="M20.4 12a8.4 8.4 0 1 1-2.5-6" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
    <path d="M20.7 3.4v5h-5" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
  </Ico>
)
const IcoMash = () => <Ico d="M12 1.8l1.9 5.3 5.3-1.9-2.9 4.5 4.9 2.2-5.9 2.6 2.9 4.8-5.3-2.1L12 22.2l-1.9-4-5.3 2.1 2.9-4.8L2.8 13l4.9-2.2-2.9-4.5 5.3 1.9L12 1.8z" />

// ---------- Virtual joystick (MOB-1) ----------
// Floating analog stick: push forward = gas, pull back = brake/reverse,
// left/right = steering. Pointer capture keeps the hold through thumb drift.
/** Call of Duty-style swipe steering: the right half of the screen is a drag
    surface — the car turns WHILE the finger moves, exactly like aiming in CoD
    Mobile. A fast flick throws the car into the turn, a slow drag eases it,
    and a held-still finger goes straight. The joystick keeps throttle; the
    right thumb owns direction. Sits below the on-screen buttons so touches
    that start on a button never steer. */
function SwipeSteerZone({ engine, enabled }: { engine: GameEngine | null; enabled: boolean }) {
  const [active, setActive] = useState(false)
  const lastX = useRef(0)
  const mag = useRef(0)
  const sign = useRef(1)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const fillRef = useRef<HTMLDivElement | null>(null)

  // Indicator decay runs on rAF and writes styles directly — no re-renders.
  useEffect(() => {
    if (!enabled) return
    let raf = 0
    const tick = () => {
      mag.current *= 0.8
      const el = trackRef.current
      const f = fillRef.current
      if (el && f) {
        if (mag.current < 0.04) {
          el.style.opacity = '0'
        } else {
          el.style.opacity = '1'
          f.style.width = `${Math.min(100, mag.current * 100)}%`
          f.style.left = sign.current >= 0 ? '50%' : ''
          f.style.right = sign.current < 0 ? '50%' : ''
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [enabled])

  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!active) return
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    setActive(false)
    engine?.touchSwipeSteer(null)
  }
  if (!enabled) return null
  return (
    <>
      <div
        className="swipe-zone"
        onPointerDown={(e) => {
          e.preventDefault()
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            /* pointer capture unsupported */
          }
          lastX.current = e.clientX
          setActive(true)
        }}
        onPointerMove={(e) => {
          if (!active) return
          const dx = e.clientX - lastX.current
          lastX.current = e.clientX
          if (Math.abs(dx) < 0.5) return
          engine?.touchSwipeDelta(dx)
          if (Math.abs(dx) > 1) sign.current = Math.sign(dx)
          mag.current = Math.min(1, mag.current + Math.abs(dx) / 16)
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="steer-indicator" ref={trackRef} style={{ opacity: 0 }} aria-hidden="true">
        <div className="steer-indicator-track">
          <div className="steer-indicator-fill" ref={fillRef} />
        </div>
      </div>
    </>
  )
}

function Joystick({ engine }: { engine: GameEngine | null }) {  const R = 44
  const [knob, setKnob] = useState({ x: 0, y: 0, active: false })
  const apply = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    let dx = e.clientX - cx
    let dy = e.clientY - cy
    const len = Math.hypot(dx, dy)
    if (len > R) {
      dx = (dx / len) * R
      dy = (dy / len) * R
    }
    setKnob({ x: dx, y: dy, active: true })
    engine?.touchAnalog(dx / R, -dy / R)
  }
  const release = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    setKnob({ x: 0, y: 0, active: false })
    engine?.touchAnalog(null, null)
  }
  return (
    <div
      className="joy-base pointer-events-auto touch-none select-none"
      onPointerDown={(e) => {
        e.preventDefault()
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* pointer capture unsupported */
        }
        apply(e)
      }}
      onPointerMove={(e) => {
        if (knob.active) apply(e)
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="joy-knob"
        style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }}
      />
      {/* gamepad-style direction chevrons around the rim */}
      <svg className="joy-chev joy-chev-n" viewBox="0 0 10 6" aria-hidden="true"><path d="M5 0l5 6H0z" fill="currentColor" /></svg>
      <svg className="joy-chev joy-chev-s" viewBox="0 0 10 6" aria-hidden="true"><path d="M5 6L0 0h10z" fill="currentColor" /></svg>
      <svg className="joy-chev joy-chev-w" viewBox="0 0 6 10" aria-hidden="true"><path d="M0 5l6-5v10z" fill="currentColor" /></svg>
      <svg className="joy-chev joy-chev-e" viewBox="0 0 6 10" aria-hidden="true"><path d="M6 5L0 0v10z" fill="currentColor" /></svg>
    </div>
  )
}


// ---------- Touch-aware tutorial text (mobile shows touch controls, not keys) ----------
/** Rolling mechanical-counter speed: each digit is a 0-9 column that springs
    into place when the speed changes — small, fixed width, no layout shift. */
function SpeedDigits({ value, boosting }: { value: number; boosting: boolean }) {
  const digits = String(Math.min(Math.max(Math.round(value), 0), 999)).padStart(3, '0').slice(-3).split('')
  return (
    <div className={`speed-digits ${boosting ? 'speed-digits-boost' : ''}`} aria-label={`${value} km/h`}>
      {digits.map((d, i) => (
        <div className="speed-digit" key={i}>
          <div className="speed-digit-col" style={{ transform: `translateY(-${Number(d)}em)` }}>
            {'0123456789'.split('').map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// Strip desktop-keyboard phrasing out of any engine toast before it reaches a
// touch player — mobile must never see "press E / ESC / SHIFT / SPACE / WASD".
function sanitizeForTouch(msg: string) {
  return msg
    .replace(/press E\b/gi, 'tap E')
    .replace(/\bESC opens the menu\b/gi, 'tap ⏸ for the menu')
    .replace(/\bESC\b/g, '⏸')
    .replace(/hold SHIFT/gi, 'hold NITRO')
    .replace(/\bSHIFT\b/g, 'NITRO')
    .replace(/press R\b/gi, 'tap RESET')
    .replace(/MASH SPACE/gi, 'MASH THE BUTTON')
    .replace(/\bSPACE\b/g, 'DRIFT')
    .replace(/press T\b/gi, 'tap ✕')
    .replace(/\bWASD\b/g, 'the joystick')
    .replace(/arrow keys/gi, 'the joystick')
}

function touchTitle(t: string) {
  if (/HOLD W|accelerate/i.test(t)) return 'DRIVE'
  if (/STEER/i.test(t)) return 'STEER'
  if (/SHIFT|nitro/i.test(t)) return 'NITRO BOOST'
  if (/DRIFT|SPACE/i.test(t)) return 'DRIFT'
  if (/press E|GARAGE|Job/i.test(t)) return t.replace(/press E/i, 'Tap E')
  return t
}

// Contract beacons on the map (Phase 1 step 3): per-job labels and colors for
// the accept card that appears when you drive into one.
const JOB_LABEL: Record<string, string> = { delivery: 'COURIER RUN', taxi: 'TAXI FARE', race: 'STREET RACE', getaway: 'GETAWAY' }
const JOB_TEXT_CLS: Record<string, string> = { delivery: 'text-cyan-300', taxi: 'text-amber-300', race: 'text-pink-300', getaway: 'text-red-300' }
const JOB_BORDER_CLS: Record<string, string> = { delivery: 'border-cyan-400/40', taxi: 'border-amber-400/40', race: 'border-pink-400/40', getaway: 'border-red-400/40' }
function touchHint(h: string) {
  if (/WASD|arrow keys|HOLD W/i.test(h)) return 'Push the joystick UP to drive — steer by swiping the RIGHT side of the screen'
  if (/Tap A or D/i.test(h)) return 'Swipe LEFT or RIGHT on the right side to turn — flick for sharp turns. Try a corner'
  if (/SHIFT/i.test(h)) return 'Tap NITRO on the right to boost — it recharges on its own'
  if (/SPACE|Handbrake/i.test(h)) return 'Hold DRIFT in a turn to slide. Drifts earn cash chains'
  if (/press E/i.test(h)) return 'Tap the E button at the garage — jobs, races, taxi fares and getaways await'
  return h
}

// Wrap key names (W, E, SPACE, SHIFT...) in an animated key-cap badge so the
// instruction "press E" visually points at the exact key to hit.
const KEY_TOKENS = /\b(WASD|SPACE|SHIFT|ENTER|ESCAPE|ESC|ARROW KEYS|UP|DOWN|LEFT|RIGHT|[WASDECRTHZ])\b/gi
function hintWithKeys(text: string, amber = false) {
  const parts = text.split(KEY_TOKENS)
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className={`key-cap ${amber ? 'key-cap-amber' : ''}`}>{part.toUpperCase()}</span>
    ) : (
      <span key={i}>{part}</span>
    )
  )
}

// ---------- Live environment preview (animated mini-scene for theme cards) ----------
function ThemePreview({ theme }: { theme: Theme }) {
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`
  return (
    <div
      className="relative h-14 rounded-lg mb-2 overflow-hidden"
      style={{ background: `linear-gradient(180deg, ${hex(theme.sky)} 0%, ${hex(theme.fog)} 78%)` }}
    >
      {/* sun / moon */}
      <div
        className="absolute rounded-full"
        style={{
          width: 14, height: 14, right: 12, top: 6,
          background: hex(theme.moon),
          boxShadow: `0 0 14px 3px ${hex(theme.moon)}`,
        }}
      />
      {/* skyline silhouette */}
      <div className="absolute bottom-2 left-2 right-2 flex items-end gap-[3px] opacity-70">
        {[10, 16, 8, 13, 18, 9, 14, 11].map((h, i) => (
          <div key={i} className="flex-1 rounded-[1px]" style={{ height: h, background: hex(theme.sky), filter: 'brightness(1.6)' }} />
        ))}
      </div>
      {/* water line */}
      <div className="absolute bottom-0 inset-x-0 h-2" style={{ background: hex(theme.water), opacity: 0.9 }} />
      {/* rain streaks */}
      {theme.rain && <div className="theme-rain absolute inset-0" />}
    </div>
  )
}

// ---------- Shop item card ----------
function ShopCard(props: {
  name: string
  desc: string
  swatch: number
  glow: number
  price: number // in-game cash; 0 = not sold for cash
  premium: boolean
  earned?: boolean // prestige item unlocked by in-game feats
  minLevel: number
  isOwned: boolean
  isEquipped: boolean
  level: number
  standalone: boolean // true when running outside vplay.gg
  vcPrice: number | null // VCoin price advertised by vplay.gg
  preview?: React.ReactNode // replaces the swatch block (e.g. live environment preview)
  onBuy: () => void
  onBuyVc?: () => void
  onEquip: () => void
}) {
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`
  const levelBlocked = props.level < props.minLevel
  const vcBtn = props.vcPrice != null && (
    <button
      onClick={props.onBuyVc}
      title="Unlock instantly with VCoins on vplay.gg"
      className="px-2.5 py-1.5 text-xs font-black border border-amber-500/60 text-amber-300 rounded hover:bg-amber-500/10 whitespace-nowrap"
    >
      ◈ {props.vcPrice.toLocaleString()}
    </button>
  )
  return (
    <div className={`shop-item relative rounded-xl border p-3 bg-slate-800/60 transition-all ${props.isEquipped ? 'border-cyan-400 shadow-[0_0_16px_rgba(34,211,238,0.35)]' : 'border-slate-700 hover:border-slate-500'}`}>
      {props.earned && (
        <div className="absolute -top-2 -right-2 bg-cyan-400 text-black text-[10px] font-black px-2 py-0.5 rounded-full">🏆 EARNED</div>
      )}
      {!props.earned && props.premium && (
        <div className="absolute -top-2 -right-2 bg-amber-500 text-black text-[10px] font-black px-2 py-0.5 rounded-full">PREMIUM</div>
      )}
      {props.preview ?? (
        <div className="shop-item-preview h-14 rounded-lg mb-2 flex items-end justify-center" style={{ background: `linear-gradient(135deg, ${hex(props.swatch)}, #0b0d14)` }}>
          <div className="w-24 h-2 rounded-full mb-2" style={{ background: hex(props.glow), boxShadow: `0 0 14px ${hex(props.glow)}` }} />
        </div>
      )}
      <div className="text-white font-bold text-sm">{props.name}</div>
      <div className="shop-item-desc text-slate-300 text-[13px] mt-0.5 leading-snug min-h-[2rem]">{props.desc}</div>
      <div className="mt-2">
        {props.isEquipped ? (
          <div className="text-center text-cyan-300 text-xs font-bold py-1.5 border border-cyan-500/50 rounded">EQUIPPED</div>
        ) : props.isOwned ? (
          <button onClick={props.onEquip} className="w-full py-1.5 text-xs font-bold border border-slate-500 text-slate-200 rounded hover:bg-slate-700">EQUIP</button>
        ) : props.earned ? (
          <div className="text-center text-cyan-200/80 text-[11px] py-1.5 border border-cyan-500/30 rounded bg-cyan-500/5">Unlock by playing — earn every trophy, reach level 10</div>
        ) : levelBlocked ? (
          <div className="flex items-center gap-1.5">
            <div className="flex-1 text-center text-slate-500 text-[11px] py-1.5 border border-slate-800 rounded">Requires level {props.minLevel}</div>
            {vcBtn}
          </div>
        ) : props.vcPrice != null ? (
          props.price > 0 ? (
            <div className="flex gap-1.5">
              <button onClick={props.onBuy} className="flex-1 py-1.5 text-xs font-bold border border-emerald-500/60 text-emerald-300 rounded hover:bg-emerald-500/10">
                BUY — ${props.price.toLocaleString()}
              </button>
              {vcBtn}
            </div>
          ) : (
            <div className="flex gap-1.5">
              <button onClick={props.onBuyVc} className="flex-1 py-1.5 text-xs font-black border border-amber-500/70 text-amber-300 rounded hover:bg-amber-500/15">
                ◈ {props.vcPrice.toLocaleString()}
              </button>
            </div>
          )
        ) : props.premium && props.standalone ? (
          <button
            onClick={() => VPlay.openOnVplay()}
            className="w-full py-1.5 text-xs font-bold border border-amber-500/60 text-amber-300 rounded hover:bg-amber-500/10"
          >
            UNLOCK ON VPLAY.GG
          </button>
        ) : props.price > 0 ? (
          <button onClick={props.onBuy} className="w-full py-1.5 text-xs font-bold border border-emerald-500/60 text-emerald-300 rounded hover:bg-emerald-500/10">
            BUY — ${props.price.toLocaleString()}
          </button>
        ) : (
          <div className="text-center text-slate-600 text-[11px] py-1.5">Available on vplay.gg</div>
        )}
      </div>
    </div>
  )
}
