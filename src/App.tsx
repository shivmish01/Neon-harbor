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
  ACHIEVEMENTS, DISTRICTS,
  type Skin, type Theme,
} from './game/content'
import { loadSave, persistSave, defaultSave, type SaveData } from './game/save'
import { VPlay, type VPlayInit, type PurchaseResult } from './vplay/sdk'

type Screen = 'boot' | 'menu' | 'game'
type Overlay = null | 'shop' | 'jobs' | 'pause' | 'help' | 'progress'

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
  const [shopTab, setShopTab] = useState<'skins' | 'themes'>('skins')
  const [progressTab, setProgressTab] = useState<'trophies' | 'districts'>('trophies')
  const [tutorialHidden, setTutorialHidden] = useState(false)
  const [photoMode, setPhotoMode] = useState(false)
  const [photoFilter, setPhotoFilter] = useState(0)
  const [save, setSave] = useState<SaveData>(() => loadSave())
  const [hud, setHud] = useState<HudState | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [bustedFlash, setBustedFlash] = useState(false)
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
  // Mobile/tablet players get on-screen drive controls instead of keyboard hints
  const [isTouch] = useState(
    () => typeof window !== 'undefined' && (window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window),
  )
  // Mobile plays in landscape — portrait shows a "rotate your device" screen
  const [isPortrait, setIsPortrait] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(orientation: portrait)').matches,
  )
  useEffect(() => {
    if (!isTouch) return
    const mq = window.matchMedia('(orientation: portrait)')
    const update = () => setIsPortrait(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [isTouch])

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
    setToasts((t) => [...t.slice(-3), { id, msg, kind }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
  }, [])

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
    VPlay.saveCloud({ cash: s.cash, xp: s.xp, level: s.level, shards: s.shards, owned: s.owned, skin: s.skin, theme: s.theme, achievements: s.achievements, districts: s.districts, landmarks: s.landmarks, tollsPaid: s.tollsPaid, stats: s.stats, tutorialDone: s.tutorialDone })
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
      // host is back — audio needs a user gesture, so show tap-to-continue
      setHostPaused(true)
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
        setHostPaused(true) // tap-to-continue on return (audio gesture)
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
      onLevelUp: (level) => pushToast(`LEVEL UP — you reached level ${level}!`, 'good'),
      onMissionDone: (name, reward) => pushToast(`${name} complete!  +$${reward}`, 'good'),
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
    // MOB-3: quality watchdog — touch devices always get it; desktop keeps full
    // quality UNLESS the browser is CPU-rendering (SwiftShader/llvmpipe), where
    // full effects can hard-lock a weak renderer. Real desktops stay untouched.
    const software = engine.isSoftwareRenderer()
    engine.setAutoQualityEnabled(isTouch || software, isTouch ? 42 : 24)
    engineRef.current = engine
    return engine
  }, [commit, pushToast, isTouch])

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
      setScreen('game')
    } catch (err) {
      pushToast(`Could not start: ${err instanceof Error ? err.message : String(err)}`, 'warn')
      throw err
    }
  }, [ensureEngine, pushToast])

  enterGameRef.current = enterGame

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

  // Pause only for modal overlays during gameplay — menus keep the city alive
  useEffect(() => {
    engineRef.current?.setPaused(screen === 'game' && (overlay !== null || (isTouch && isPortrait)))
    // Never leave a held touch button "stuck" when a menu opens over the game
    if (overlay !== null) engineRef.current?.touchReset()
    // Any menu opening exits photo mode cleanly
    if (overlay !== null && photoMode) {
      engineRef.current?.setPhotoMode(false)
      setPhotoMode(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, screen, isTouch, isPortrait])

  // Escape opens/closes pause
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (screenRef.current !== 'game') return
      setOverlay((o) => (o === null ? 'pause' : o === 'pause' ? null : o))
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
    <div className="fixed inset-0 overflow-hidden bg-black font-game select-none">
      {/* 3D canvas (live behind every screen) — photo filters tint only in photo mode */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full block"
        style={{ filter: photoMode ? PHOTO_FILTERS[photoFilter].css : undefined }}
      />

      {/* minimap canvas — always mounted, engine needs it before entering */}
      <canvas
        ref={minimapRef}
        width={180}
        height={180}
        className={`nh-minimap absolute top-4 right-4 z-20 rounded-lg border border-cyan-500/30 shadow-[0_0_20px_rgba(34,211,238,0.25)] ${screen === 'game' && hud ? '' : 'hidden'}`}
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
              <div className="nh-splash-kicker text-slate-500 tracking-[0.55em] text-xs md:text-sm mb-6 animate-pulse">PRESENTS</div>
              <img
                src="logos/varygaming.png"
                alt="Vary Gaming"
                className="nh-splash-logo w-[78vw] max-w-xl md:max-w-2xl drop-shadow-[0_0_28px_rgba(34,211,238,0.35)]"
                draggable={false}
              />
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
          <div className="text-cyan-400 tracking-[0.5em] text-sm mb-3 animate-pulse">EARLY ACCESS {GAME_VERSION}</div>
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
          <p className="text-slate-500 text-xs mt-8">Headphones recommended — sound starts on entry</p>
        </div>
      )}

      {/* ================= MAIN MENU ================= */}
      {screen === 'menu' && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/55 backdrop-blur-[2px]">
          <div className="text-cyan-400 tracking-[0.5em] text-xs mb-2">EARLY ACCESS {GAME_VERSION}</div>
          <h1 className="nh-menu-title text-5xl md:text-7xl font-black text-white neon-cyan tracking-wider">{GAME_TITLE}</h1>
          <img src="logos/vplaygg.svg" alt="vplay.gg exclusive" className="nh-menu-tag h-5 mt-3 opacity-90" draggable={false} />
          <div className="nh-menu-gap flex gap-3 mt-10 menu-in">
            <button onClick={enterGame} className="menu-btn menu-btn-primary btn-attend">DRIVE</button>
            <button onClick={() => setOverlay('shop')} className="menu-btn">GARAGE SHOP</button>
            <button onClick={() => setOverlay('help')} className="menu-btn">HOW TO PLAY</button>
          </div>
          <div className="nh-menu-gap flex gap-3 mt-3 menu-in">
            <button onClick={() => { setProgressTab('trophies'); setOverlay('progress') }} className="menu-btn menu-btn-ghost">🏆 TROPHIES</button>
            <button onClick={() => { setProgressTab('districts'); setOverlay('progress') }} className="menu-btn menu-btn-ghost">🗺️ DISTRICTS</button>
            <button onClick={() => setOverlay('shop')} className="menu-btn menu-btn-ghost border-amber-400/60 text-amber-300 btn-attend-amber">🔓 HARBOR PASS</button>
          </div>
          <div className="nh-menu-stats mt-10 text-slate-300 text-sm flex gap-8">
            <span>Cash <b className="text-emerald-400">${save.cash}</b></span>
            <span>Level <b className="text-cyan-400">{save.level}</b></span>
            <span>Shards <b className="text-cyan-400">{save.shards.length}/24</b></span>
            <span>Deliveries <b className="text-cyan-400">{save.stats.deliveries}</b></span>
            <span>Races <b className="text-cyan-400">{save.stats.races}</b></span>
          </div>
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
          {/* top-left: cash / level */}
          <div className="absolute top-4 left-4 z-20 space-y-2">
            <div className="hud-panel text-2xl font-bold text-emerald-400">${hud.cash.toLocaleString()}</div>
            {hud.chainMult > 1 && (
              <div className="hud-panel border-fuchsia-400/60 text-fuchsia-300 text-xs font-black tracking-widest animate-pulse">
                STREET CRED ×{hud.chainMult.toFixed(2)}
              </div>
            )}
            <div className="hud-panel">
              <div className="flex justify-between text-[11px] text-slate-300">
                <span>LVL {hud.level}</span>
                <span>{hud.xp}/{hud.xpNext} XP</span>
              </div>
              <div className="w-44 h-2 bg-slate-800 rounded mt-1">
                <div className="h-full bg-cyan-400 rounded" style={{ width: `${Math.min((hud.xp / hud.xpNext) * 100, 100)}%` }} />
              </div>
            </div>
          </div>

          {/* top-center: mission tracker */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 w-[26rem] max-w-[80vw]">
            {hud.mission ? (
              <div className="hud-panel border-yellow-400/40 w-full">
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
              </div>
            ) : (
              <div className="hud-panel text-center text-[13px] text-slate-300">
                {isTouch ? <>Free roam — head to the <span className="text-cyan-300">glowing garage beam</span> for jobs</> : <>Free roam — visit the <span className="text-cyan-300">glowing garage beam</span> and press <span className="key-cap">E</span> for jobs</>}
              </div>
            )}
          </div>

          {/* first-night tutorial objective — dims after a few seconds so it stops
              hogging the screen; ✕ dismisses it for this run (T skips forever) */}
          {hud.tutorial && !tutorialHidden && (
            <div
              key={hud.tutorial.step}
              className="absolute top-24 left-1/2 -translate-x-1/2 z-20 w-[24rem] max-w-[80vw] animate-pulse tutorial-dim"
            >
              <div className="hud-panel border-cyan-400/70 shadow-[0_0_28px_rgba(34,211,238,0.3)] w-full">
                <div className="flex justify-between text-[12px] tracking-[0.2em] text-cyan-300">
                  <span>FIRST NIGHT — {hud.tutorial.step}/{hud.tutorial.total}</span>
                  <span className="flex items-center gap-2">
                    {!isTouch && <span className="text-slate-500 hidden sm:inline">press T to skip</span>}
                    <button
                      onClick={() => setTutorialHidden(true)}
                      className="text-slate-400 hover:text-white leading-none"
                      aria-label="Hide tutorial"
                    >✕</button>
                  </span>
                </div>
                <div className="text-white font-bold text-base mt-1 leading-snug">{isTouch ? touchTitle(hud.tutorial.title) : hud.tutorial.title}</div>
                <div className="text-[13px] text-slate-200 mt-1 leading-relaxed">{isTouch ? touchHint(hud.tutorial.hint) : hintWithKeys(hud.tutorial.hint)}</div>
              </div>
            </div>
          )}

          {/* top-right (below minimap): heat with live police instructions */}
          <div className="absolute top-[196px] right-4 z-20 flex flex-col items-end gap-2">
            <div className={`hud-panel flex flex-col items-end gap-1 ${hud.heatStars > 0 ? 'border-red-500/70 shadow-[0_0_18px_rgba(255,50,80,0.4)]' : ''}`}>
              <div className="flex gap-1 items-center">
                <span className="text-xs text-slate-400 mr-1 tracking-widest">PATROL</span>
                {[1, 2, 3, 4, 5].map((i) => (
                  <span key={i} className={`text-base ${hud.heat >= i ? 'text-red-500 drop-shadow-[0_0_6px_rgba(255,50,80,0.9)]' : 'text-slate-700'}`}>★</span>
                ))}
              </div>
              {hud.heatStars > 0 && (
                <div className="text-xs text-red-200 text-right leading-snug max-w-[13rem]">
                  {hud.bustedProgress > 0.25 ? (
                    <span className="text-red-400 font-bold animate-pulse text-[13px]">
                      {isTouch ? '⚠ GRABBED — MASH THE BUTTON!' : <>⚠ GRABBED — MASH <span className="key-cap key-cap-amber" style={{ animationDuration: '0.4s' }}>SPACE</span> to break free!</>}
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
            <div className="hud-panel text-xs text-slate-400">
              Shards <span className="text-cyan-300 font-bold">{hud.shards}/{hud.totalShards}</span>
            </div>
          </div>

          {/* bottom-left: Asphalt-style circular speedometer + nitro ring (raised on touch so it never sits under the joystick) */}
          <div className={`absolute left-4 z-20 ${isTouch ? 'bottom-44' : 'bottom-4'}`}>
            {isTouch ? (
              <Speedo speed={hud.speedKmh} boost={hud.boost} boosting={hud.boosting} drift={hud.drift} />
            ) : (
              <div className="hud-panel">
                <div className="text-4xl font-black text-white font-mono">{hud.speedKmh}<span className="text-base text-slate-400 font-normal"> km/h</span></div>
                <div className="w-48 h-2 bg-slate-800 rounded mt-2">
                  <div className={`h-full rounded ${hud.boosting ? 'bg-fuchsia-400 shadow-[0_0_12px_rgba(232,121,249,0.9)]' : 'bg-cyan-500'}`} style={{ width: `${hud.boost}%` }} />
                </div>
                <div className="text-[10px] text-slate-400 mt-1">NITRO — hold SHIFT{hud.drift > 0 && <span className="text-yellow-300 ml-2">DRIFT {hud.drift}</span>}</div>
              </div>
            )}
          </div>

          {/* bottom-right: keyboard hints (desktop only) */}
          {!isTouch && (
            <div className="absolute bottom-4 right-4 z-20 hud-panel text-[11px] text-slate-400 leading-relaxed">
              <b className="text-slate-200">WASD</b> drive · <b className="text-slate-200">SHIFT</b> nitro · <b className="text-slate-200">SPACE</b> handbrake · <b className="text-slate-200">R</b> unstuck<br />
              <b className="text-slate-200">E</b> job board · <b className="text-slate-200">H</b> horn · <b className="text-slate-200">C</b> camera · <b className="text-slate-200">ESC</b> menu
            </div>
          )}

          {/* ======== TOUCH CONTROLS (mobile / tablet) ========
              Two schemes: virtual joystick (default) or classic buttons */}
          {isTouch && !overlay && save.controls !== 'buttons' && (
            <div className="absolute inset-0 z-30 pointer-events-none">
              <div
                className="absolute inset-x-0 bottom-0 flex justify-between items-end gap-3 px-3 sm:px-4"
                style={{ paddingBottom: 'max(3.5rem, env(safe-area-inset-bottom))' }}
              >
                {/* virtual joystick: push forward = gas, side = steer, back = brake */}
                <div className="pointer-events-auto">
                  <Joystick engine={engineRef.current} />
                </div>
                {/* actions + nitro/drift */}
                <div className="flex flex-col items-end gap-2 pointer-events-auto">
                  <div className="flex gap-2">
                    {(hud.nearGarage || hud.nearToll) && <TouchBtn engine={engineRef.current} label="E" tap="e" small />}
                    {hud.stuck && <TouchBtn engine={engineRef.current} label="RESET" tap="r" small />}
                    <button onClick={togglePhoto} className="touch-btn touch-btn-sm" aria-label="Photo mode">📷</button>
                    <TouchBtn engine={engineRef.current} label="📯" tap="h" small />
                    <button
                      onClick={() => setOverlay('pause')}
                      className="touch-btn touch-btn-sm"
                      aria-label="Pause"
                    >
                      II
                    </button>
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex flex-col gap-2">
                      <TouchBtn engine={engineRef.current} label="⚡" hold="shift" variant="nitro" ready={hud.boost >= 95} lit={hud.boosting} />
                      <TouchBtn engine={engineRef.current} label="DRIFT" hold=" " variant="drift" />
                    </div>
                  </div>
                </div>
              </div>
              {/* big mash button when the Patrol grabs the car */}
              {hud.bustedProgress > 0.2 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-auto">
                  <TouchBtn engine={engineRef.current} label="MASH!" tap=" " mash />
                </div>
              )}
            </div>
          )}

          {/* classic button scheme (opt-in from the pause menu) */}
          {isTouch && !overlay && save.controls === 'buttons' && (
            <div className="absolute inset-0 z-30 pointer-events-none">
              <div
                className="absolute inset-x-0 bottom-0 flex justify-between items-end gap-3 px-3 sm:px-4"
                style={{ paddingBottom: 'max(3.5rem, env(safe-area-inset-bottom))' }}
              >
                {/* steering */}
                <div className="flex gap-3 pointer-events-auto">
                  <TouchBtn engine={engineRef.current} label="◀" hold="a" />
                  <TouchBtn engine={engineRef.current} label="▶" hold="d" />
                </div>
                {/* actions (top-right) + pedals (2x2 grid, bottom-right) */}
                <div className="flex flex-col items-end gap-2 pointer-events-auto">
                  <div className="flex gap-2">
                    {(hud.nearGarage || hud.nearToll) && <TouchBtn engine={engineRef.current} label="E" tap="e" small />}
                    {hud.stuck && <TouchBtn engine={engineRef.current} label="RESET" tap="r" small />}
                    <button onClick={togglePhoto} className="touch-btn touch-btn-sm" aria-label="Photo mode">📷</button>
                    <TouchBtn engine={engineRef.current} label="📯" tap="h" small />
                    <button
                      onClick={() => setOverlay('pause')}
                      className="touch-btn touch-btn-sm"
                      aria-label="Pause"
                    >
                      II
                    </button>
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex flex-col gap-2">
                      <TouchBtn engine={engineRef.current} label="⚡" hold="shift" variant="nitro" ready={hud.boost >= 95} lit={hud.boosting} />
                      <TouchBtn engine={engineRef.current} label="DRIFT" hold=" " variant="drift" />
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
                  <TouchBtn engine={engineRef.current} label="MASH!" tap=" " mash />
                </div>
              )}
            </div>
          )}

          {/* E prompt — job board at the garage, or toll booth at a locked border */}
          {!overlay && !isTouch && hud.nearGarage && (
            <div className="nh-prompt absolute bottom-24 left-1/2 -translate-x-1/2 z-20 px-4 py-2.5 bg-cyan-500/20 border border-cyan-400 rounded text-cyan-100 text-base animate-pulse">
              Press <span className="key-cap">E</span> — open the Job Board
            </div>
          )}
          {!overlay && !isTouch && !hud.nearGarage && hud.nearToll && (
            <div className="nh-prompt absolute bottom-24 left-1/2 -translate-x-1/2 z-20 px-4 py-2.5 bg-amber-500/20 border border-amber-400 rounded text-amber-100 text-base animate-pulse">
              Press <span className="key-cap key-cap-amber">E</span> — pay ${hud.nearToll.price} toll to enter {hud.nearToll.name}
            </div>
          )}

          {/* stuck recovery — car wedged on a pole/barrier/wall: offer the reset */}
          {!overlay && hud.stuck && (
            <div className="nh-prompt absolute bottom-40 left-1/2 -translate-x-1/2 z-20 px-5 py-3 bg-amber-500/25 border-2 border-amber-400 rounded-lg text-amber-100 text-base font-bold animate-pulse text-center">
              {isTouch ? <>Car stuck? Tap <span className="key-cap key-cap-amber">RESET</span></> : <>Car stuck? Press <span className="key-cap key-cap-amber">R</span> to get back on the road</>}
            </div>
          )}

          {/* early access badge (desktop only; mobile keeps the view clean) */}
          {!isTouch && (
            <div className="absolute bottom-1 left-1/2 -translate-x-1/2 z-10 text-[10px] tracking-[0.4em] text-slate-600">
              EARLY ACCESS — progress is saved locally
            </div>
          )}

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

          {/* toasts */}
          <div className="absolute bottom-32 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1 pointer-events-none">
            {toasts.map((t) => (
              <div key={t.id} className={`toast toast-${t.kind}`}>{t.msg}</div>
            ))}
          </div>
        </>
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
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <h2 className="text-4xl font-black text-white tracking-[0.3em] mb-8">PAUSED</h2>
          <div className="flex flex-col gap-3 w-64">
            <button onClick={() => setOverlay(null)} className="menu-btn menu-btn-primary btn-attend">RESUME</button>
            <button onClick={() => setOverlay('shop')} className="menu-btn">GARAGE SHOP</button>
            <button onClick={() => setOverlay('help')} className="menu-btn">HOW TO PLAY</button>
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
          <div className="w-[52rem] max-w-[94vw] max-h-[86vh] overflow-y-auto bg-slate-900/95 border border-fuchsia-500/30 rounded-2xl p-6 shadow-[0_0_60px_rgba(232,121,249,0.15)]">
            <h2 className="text-2xl font-black text-white tracking-widest mb-1">GARAGE SHOP</h2>
            <div className="flex justify-between items-start mb-4">
              <div className="text-slate-400 text-xs pt-1">
                Balance: <span className="text-emerald-400 font-bold">${save.cash.toLocaleString()}</span> · Level {save.level}
                {vplay?.mode === 'vplay' && (
                  <span className="ml-3">VCoins: <span className="text-amber-300 font-bold">◈ {vcBalance.toLocaleString()}</span></span>
                )}
              </div>
              <button onClick={() => setOverlay(null)} className="text-slate-400 hover:text-white text-xl">✕</button>
            </div>

            {/* Harbor Pass banner */}
            {isOwned(HARBOR_PASS_ID) ? (
              <div className="w-full mb-5 p-3 rounded-xl border border-emerald-400/40 bg-emerald-500/10 text-emerald-300 text-sm text-center">
                🔓 HARBOR PASS owned — all premium content unlocked
              </div>
            ) : vplay?.mode === 'vplay' ? (
              <div className="w-full mb-5 p-4 rounded-xl border border-amber-400/50 bg-gradient-to-r from-amber-500/15 to-fuchsia-500/15">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-amber-300 font-black tracking-widest">HARBOR PASS</div>
                    <div className="text-slate-300 text-xs mt-1">Unlocks all {HARBOR_PASS_ITEMS.length} premium cars and environments (Ghost, Royal, Solar, Oni, Sakura Dusk, Acid Rain) in one go.</div>
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
              <div className="w-full mb-5 p-4 rounded-xl border border-amber-400/50 bg-gradient-to-r from-amber-500/15 to-fuchsia-500/15">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-amber-300 font-black tracking-widest">HARBOR PASS</div>
                    <div className="text-slate-300 text-xs mt-1">Unlocks all premium cars and environments with one purchase on vplay.gg.</div>
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
            <div className="flex gap-2 mb-4">
              <button onClick={() => setShopTab('skins')} className={`shop-tab ${shopTab === 'skins' ? 'shop-tab-on' : ''}`}>CAR SKINS</button>
              <button onClick={() => setShopTab('themes')} className={`shop-tab ${shopTab === 'themes' ? 'shop-tab-on' : ''}`}>CITY THEMES</button>
            </div>

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


      {/* ================= HELP ================= */}
      {overlay === 'help' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-[34rem] max-w-[92vw] bg-slate-900/95 border border-cyan-500/30 rounded-2xl p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-2xl font-black text-white tracking-widest">HOW TO PLAY</h2>
              <button onClick={() => setOverlay(null)} className="text-slate-400 hover:text-white text-xl">✕</button>
            </div>
            <div className="text-slate-300 text-sm space-y-3 leading-relaxed">
              <p><b className="text-cyan-300">Drive & earn.</b>{' '}
                {isTouch
                  ? <>Take courier jobs and races from the Job Board — drive into the <b>glowing cyan beam</b> in the city center and tap the <b>E</b> button. Finish fast for bigger payouts.</>
                  : <>Take courier jobs and races from the Job Board (glowing cyan beam in the city center, press E). Finish fast for bigger payouts.</>}
              </p>
              <p><b className="text-cyan-300">Explore.</b> 24 data shards glow around the city. Orange ramps pay airtime bonuses. Handbrake drifts around corners pay too. Five districts open as you level — or pay the border toll (press E at the gate) to enter early with cash.</p>
              <p>
                <b className="text-red-300">The Patrol — read this!</b> Speeding near red patrol drones raises your ★ heat.
                <b> What to do when attacked:</b> keep driving FAST and get 60m+ away from every drone — the stars fade and they give up.
                If a drone sticks to your bumper, <b>never stop</b>. And if one grabs you,{' '}
                <b>{isTouch ? 'MASH the DRIFT button rapidly to break free' : 'mash SPACE rapidly to break free'}</b> —
                only a stopped, surrounded car gets BUSTED (15% fine, hauled back to the garage). At 3★+ you hear sirens; drones get faster every star.
              </p>
              <p><b className="text-cyan-300">Spend & customize.</b> Cash buys car skins and the Golden Hour environment. Premium cars and environments (Crimson Ghost, Royal Violet, Solar Flare, Cyber Oni, Sakura Dusk, Acid Rain) unlock with VCoins on vplay.gg — or grab the Harbor Pass for all of them at once.</p>
              <p><b className="text-fuchsia-300">Signature touches.</b>{' '}
                {isTouch
                  ? <>The 📷 button freezes the world — orbit your car with a finger, apply a color grade, and save the shot. The soundtrack intensifies as Patrol heat rises.</>
                  : <>Press <b>P</b> for photo mode: the world freezes, drag to orbit your car, scroll to zoom, grade the shot, and save a PNG. The soundtrack builds with Patrol heat. Plug in a gamepad and it just works.</>}
              </p>
              <div className="text-slate-600 text-[10px] pt-2 border-t border-slate-800">
                Character models: Quaternius (CC0) · City & cars: Kenney (CC0)
              </div>
              <div className="text-slate-500 text-xs pt-2 border-t border-slate-800">
                {isTouch ? (
                  save.controls === 'joystick'
                    ? 'Joystick: push forward to drive · tilt to steer · pull back to brake — NITRO and DRIFT buttons on the right · E jobs · 📷 photo mode · 📯 horn · II pause'
                    : '◀ ▶ steer · ▲ gas · ▼ brake/reverse · NITRO · DRIFT — E jobs · 📷 photo mode · 📯 horn · II pause'
                ) : (
                  'Controls: WASD/arrows drive · SHIFT nitro · SPACE handbrake · E job board · P photo mode · C camera · H horn · ESC pause · gamepad supported'
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================= ROTATE DEVICE (mobile portrait) ================= */}
      {isTouch && isPortrait && (
        <div className="absolute inset-0 z-[60] flex flex-col items-center justify-center bg-[#05060f]">
          <div className="rotate-phone text-5xl mb-6">📱</div>
          <div className="text-cyan-300 tracking-[0.35em] text-sm font-bold">ROTATE YOUR DEVICE</div>
          <div className="text-slate-400 text-xs mt-3 max-w-[16rem] text-center leading-relaxed">
            {GAME_TITLE} plays in landscape — turn your phone sideways for the full harbor
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- On-screen touch button (mobile controls) ----------
function TouchBtn(props: {
  engine: GameEngine | null
  label: string
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

// ---------- Virtual joystick (MOB-1) ----------
// Floating analog stick: push forward = gas, pull back = brake/reverse,
// left/right = steering. Pointer capture keeps the hold through thumb drift.
function Joystick({ engine }: { engine: GameEngine | null }) {
  const R = 44
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
    </div>
  )
}

// ---------- Asphalt-style circular speedometer (mobile) ----------
// Glass dial with a sweeping needle, a glowing speed arc, tick marks,
// a nitro charge ring around the dial, and a live km/h readout.
function Speedo({ speed, boost, boosting, drift }: { speed: number; boost: number; boosting: boolean; drift: number }) {
  const MAX = 260
  const pct = Math.min(1, Math.max(0, speed / MAX))
  const angle = -120 + pct * 240 // 240° sweep, starting bottom-left
  return (
    <div className="speedo">
      <svg viewBox="0 0 120 120" className="speedo-dial">
        <circle cx="60" cy="60" r="54" className="speedo-bg" />
        <circle cx="60" cy="60" r="45" pathLength="100" strokeDasharray={`${pct * 100} 100`} className="speedo-arc" />
        {Array.from({ length: 25 }).map((_, i) => {
          const a = ((-120 + i * 10) * Math.PI) / 180
          const r1 = 39
          const r2 = i % 5 === 0 ? 32 : 36
          return (
            <line
              key={i}
              x1={60 + r1 * Math.cos(a)}
              y1={60 + r1 * Math.sin(a)}
              x2={60 + r2 * Math.cos(a)}
              y2={60 + r2 * Math.sin(a)}
              className={i % 5 === 0 ? 'speedo-tick-major' : 'speedo-tick'}
            />
          )
        })}
        <g transform={`rotate(${angle} 60 60)`}>
          <line x1="60" y1="62" x2="60" y2="26" className="speedo-needle" />
        </g>
        <circle cx="60" cy="60" r="4.5" className="speedo-hub" />
      </svg>
      <svg viewBox="0 0 120 120" className="speedo-nitro-ring">
        <circle cx="60" cy="60" r="51" pathLength="100" strokeDasharray={`${boost} 100`} className={boosting ? 'speedo-nitro-boost' : 'speedo-nitro-idle'} />
      </svg>
      <div className="speedo-readout">
        <div className="speedo-val">{Math.round(speed)}</div>
        <div className="speedo-unit">km/h</div>
      </div>
      {drift > 0 && <div className="speedo-drift">DRIFT +{drift}</div>}
    </div>
  )
}

// ---------- Touch-aware tutorial text (mobile shows touch controls, not keys) ----------
function touchTitle(t: string) {
  if (/HOLD W|accelerate/i.test(t)) return 'DRIVE'
  if (/STEER/i.test(t)) return 'STEER'
  if (/SHIFT|nitro/i.test(t)) return 'NITRO BOOST'
  if (/DRIFT|SPACE/i.test(t)) return 'DRIFT'
  if (/press E|GARAGE|Job/i.test(t)) return t.replace(/press E/i, 'Tap E')
  return t
}
function touchHint(h: string) {
  if (/WASD|arrow keys|HOLD W/i.test(h)) return 'Push the joystick forward to drive — tilt it left and right to steer'
  if (/Tap A or D/i.test(h)) return 'Tilt the joystick while moving to turn. Try a corner'
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
    <div className={`relative rounded-xl border p-3 bg-slate-800/60 transition-all ${props.isEquipped ? 'border-cyan-400 shadow-[0_0_16px_rgba(34,211,238,0.35)]' : 'border-slate-700 hover:border-slate-500'}`}>
      {props.earned && (
        <div className="absolute -top-2 -right-2 bg-cyan-400 text-black text-[10px] font-black px-2 py-0.5 rounded-full">🏆 EARNED</div>
      )}
      {!props.earned && props.premium && (
        <div className="absolute -top-2 -right-2 bg-amber-500 text-black text-[10px] font-black px-2 py-0.5 rounded-full">PREMIUM</div>
      )}
      {props.preview ?? (
        <div className="h-14 rounded-lg mb-2 flex items-end justify-center" style={{ background: `linear-gradient(135deg, ${hex(props.swatch)}, #0b0d14)` }}>
          <div className="w-24 h-2 rounded-full mb-2" style={{ background: hex(props.glow), boxShadow: `0 0 14px ${hex(props.glow)}` }} />
        </div>
      )}
      <div className="text-white font-bold text-sm">{props.name}</div>
      <div className="text-slate-300 text-[13px] mt-0.5 leading-snug min-h-[2rem]">{props.desc}</div>
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
