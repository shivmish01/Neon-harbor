// ============================================================
// NEON HARBOR — React shell: boot screen, main menu (over the
// live 3D city), HUD with police instructions, shop, checkout.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { GameEngine, type HudState } from './game/engine'
import { loadGameAssets, type GameAssets } from './game/assets'
import {
  SKINS, THEMES, FULL_ACCESS_PRICE, GAME_VERSION, GAME_TITLE,
  type Skin, type Theme,
} from './game/content'
import { loadSave, persistSave, defaultSave, type SaveData } from './game/save'

type Screen = 'boot' | 'menu' | 'game'
type Overlay = null | 'shop' | 'jobs' | 'pause' | 'checkout' | 'help'

interface Toast {
  id: number
  msg: string
  kind: 'info' | 'cash' | 'warn' | 'good'
}

let toastId = 0

export default function App() {
  const [screen, setScreen] = useState<Screen>('boot')
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [shopTab, setShopTab] = useState<'skins' | 'themes'>('skins')
  const [save, setSave] = useState<SaveData>(() => loadSave())
  const [hud, setHud] = useState<HudState | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [bustedFlash, setBustedFlash] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  // Mobile/tablet players get on-screen drive controls instead of keyboard hints
  const [isTouch] = useState(
    () => typeof window !== 'undefined' && (window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window),
  )

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

  const commit = useCallback(() => {
    persistSave(saveRef.current)
    setSave({ ...saveRef.current })
  }, [])

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
    }, assets)
    engineRef.current = engine
    return engine
  }, [commit, pushToast])

  // Load the 3D model packs first, then create the engine so the menus
  // float over the fully-built live city.
  useEffect(() => {
    let cancelled = false
    loadGameAssets((done, total) => {
      if (!cancelled) setLoadPct(Math.round((done / Math.max(total, 1)) * 100))
    })
      .then((assets) => {
        if (cancelled) return
        assetsRef.current = assets
        setAssetsReady(true)
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

  // Test hook: ?autostart=1 jumps straight into gameplay (used for automated
  // screenshot checks; normal players never see a difference)
  useEffect(() => {
    if (!assetsReady) return
    const params = new URLSearchParams(window.location.search)
    // Test hook: ?theme=day forces an environment for screenshot checks
    const th = params.get('theme')
    if (th && THEMES.some((t) => t.id === th)) {
      saveRef.current.theme = th
      commit()
      engineRef.current?.applyLoadout()
    }
    if (params.has('autostart')) {
      enterGame()
      // Test hook: ?autostart&at=beach teleports to the shore for screenshots
      if (params.get('at') === 'beach') {
        engineRef.current?.debugTeleport(8, 226, Math.PI)
      }
      // Test hook: expose the engine so automated playtests can read state
      // (positions, heat, tutorial progress) and teleport. Dev-only surface.
      ;(window as unknown as { __nh?: unknown }).__nh = engineRef.current
    }
  }, [assetsReady, enterGame])

  // Always expose the engine handle for live debugging (read-only inspection)
  useEffect(() => {
    if (engineRef.current) (window as unknown as { __nh?: unknown }).__nh = engineRef.current
  }, [screen])

  // Pause only for modal overlays during gameplay — menus keep the city alive
  useEffect(() => {
    engineRef.current?.setPaused(screen === 'game' && overlay !== null)
    // Never leave a held touch button "stuck" when a menu opens over the game
    if (overlay !== null) engineRef.current?.touchReset()
  }, [overlay, screen])

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
    engineRef.current?.setAttract(true)
    setOverlay(null)
    setScreen('menu')
  }

  const toggleMute = () => {
    const s = saveRef.current
    s.muted = !s.muted
    engineRef.current?.setMuted(s.muted)
    commit()
  }

  const buyItem = (id: string, price: number, premium: boolean, minLevel: number) => {
    const engine = engineRef.current
    const s = saveRef.current
    if (premium && !s.fullAccess) {
      engine?.playDenied()
      setOverlay('checkout')
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
    commit()
    pushToast('Purchased — equipped!', 'good')
    equipItem(id)
  }

  const equipItem = (id: string) => {
    const s = saveRef.current
    if (SKINS.some((k) => k.id === id)) s.skin = id
    else s.theme = id
    commit()
    engineRef.current?.applyLoadout()
  }

  const owned = (id: string) => save.owned.includes(id)
  const locked = (item: { premium: boolean }) => item.premium && !save.fullAccess

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

  const fullAccess = save.fullAccess

  return (
    <div className="fixed inset-0 overflow-hidden bg-black font-game select-none">
      {/* 3D canvas (live behind every screen) */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />

      {/* minimap canvas — always mounted, engine needs it before entering */}
      <canvas
        ref={minimapRef}
        width={180}
        height={180}
        className={`absolute top-4 right-4 z-20 rounded-lg border border-cyan-500/30 shadow-[0_0_20px_rgba(34,211,238,0.25)] ${screen === 'game' && hud ? '' : 'hidden'}`}
      />

      {/* ================= BOOT ================= */}
      {screen === 'boot' && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-gradient-to-b from-[#05060f]/85 via-[#0a0d1f]/70 to-[#05060f]/85">
          <div className="text-cyan-400 tracking-[0.5em] text-sm mb-3 animate-pulse">EARLY ACCESS {GAME_VERSION}</div>
          <h1 className="text-6xl md:text-8xl font-black text-white neon-cyan tracking-wider">{GAME_TITLE}</h1>
          <div className="text-fuchsia-500 tracking-[0.4em] mt-2 text-sm md:text-base">FIRST LIGHT</div>
          <div className="text-slate-500 tracking-[0.35em] mt-3 text-[11px] uppercase">A vplay.gg exclusive</div>
          <p className="text-slate-300 mt-6 max-w-md text-center px-4 text-sm leading-relaxed">
            An open-world neon port city. Run courier jobs, race the harbor, outrun the Patrol — and build your legend.
          </p>
          {assetsReady ? (
            <button
              onClick={enterGame}
              className="mt-10 px-12 py-4 bg-cyan-500/20 border border-cyan-400 text-cyan-300 text-xl tracking-[0.3em] rounded hover:bg-cyan-400/30 hover:shadow-[0_0_30px_rgba(34,211,238,0.5)] transition-all"
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
          <h1 className="text-5xl md:text-7xl font-black text-white neon-cyan tracking-wider">{GAME_TITLE}</h1>
          <div className="text-slate-500 tracking-[0.35em] mt-3 text-[10px] uppercase">A vplay.gg exclusive</div>
          <div className="flex gap-3 mt-10">
            <button onClick={enterGame} className="menu-btn menu-btn-primary">DRIVE</button>
            <button onClick={() => setOverlay('shop')} className="menu-btn">GARAGE SHOP</button>
            <button onClick={() => setOverlay('help')} className="menu-btn">HOW TO PLAY</button>
          </div>
          <div className="mt-10 text-slate-300 text-sm flex gap-8">
            <span>Cash <b className="text-emerald-400">${save.cash}</b></span>
            <span>Level <b className="text-cyan-400">{save.level}</b></span>
            <span>Shards <b className="text-cyan-400">{save.shards.length}/24</b></span>
            <span>Deliveries <b className="text-cyan-400">{save.stats.deliveries}</b></span>
            <span>Races <b className="text-cyan-400">{save.stats.races}</b></span>
          </div>
          <button onClick={toggleMute} className="mt-6 text-slate-500 text-xs underline hover:text-slate-300">
            {save.muted ? 'Unmute sound' : 'Mute sound'}
          </button>
          <button onClick={resetProgress} className="mt-2 text-slate-600 text-xs underline hover:text-red-400">
            {confirmReset ? 'Click again to CONFIRM reset (cannot be undone)' : 'Reset progress'}
          </button>
        </div>
      )}

      {/* ================= HUD ================= */}
      {screen === 'game' && hud && (
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
              <div className="hud-panel text-center text-[11px] text-slate-400">
                Free roam — visit the <span className="text-cyan-300">glowing garage beam</span> and press <b>E</b> for jobs
              </div>
            )}
          </div>

          {/* first-night tutorial objective */}
          {hud.tutorial && (
            <div className="absolute top-24 left-1/2 -translate-x-1/2 z-20 w-[24rem] max-w-[80vw] animate-pulse">
              <div className="hud-panel border-cyan-400/70 shadow-[0_0_28px_rgba(34,211,238,0.3)] w-full">
                <div className="flex justify-between text-[10px] tracking-[0.2em] text-cyan-300">
                  <span>FIRST NIGHT — {hud.tutorial.step}/{hud.tutorial.total}</span>
                  <span className="text-slate-500">press T to skip</span>
                </div>
                <div className="text-white font-bold text-sm mt-1 leading-snug">{hud.tutorial.title}</div>
                <div className="text-[11px] text-slate-300 mt-0.5 leading-snug">{hud.tutorial.hint}</div>
              </div>
            </div>
          )}

          {/* top-right (below minimap): heat with live police instructions */}
          <div className="absolute top-[196px] right-4 z-20 flex flex-col items-end gap-2">
            <div className={`hud-panel flex flex-col items-end gap-1 ${hud.heatStars > 0 ? 'border-red-500/70 shadow-[0_0_18px_rgba(255,50,80,0.4)]' : ''}`}>
              <div className="flex gap-1 items-center">
                <span className="text-[10px] text-slate-400 mr-1 tracking-widest">PATROL</span>
                {[1, 2, 3, 4, 5].map((i) => (
                  <span key={i} className={`text-sm ${hud.heat >= i ? 'text-red-500 drop-shadow-[0_0_6px_rgba(255,50,80,0.9)]' : 'text-slate-700'}`}>★</span>
                ))}
              </div>
              {hud.heatStars > 0 && (
                <div className="text-[10px] text-red-200 text-right leading-tight max-w-[11rem]">
                  {hud.bustedProgress > 0.25 ? (
                    <span className="text-red-400 font-bold animate-pulse text-[11px]">
                      ⚠ GRABBED — MASH SPACE to break free!
                    </span>
                  ) : hud.bustedProgress > 0.08 ? (
                    <span className="text-red-400 font-bold animate-pulse text-[11px]">
                      ⚠ DON'T STOP — floor it or they'll box you in!
                    </span>
                  ) : hud.pursued ? (
                    <span className="text-amber-300 font-bold text-[11px]">
                      ★ CHASED — you're faster: hold SHIFT (boost) and keep driving to shake them!
                    </span>
                  ) : (
                    <span>EVADE — keep 60m+ from patrol drones until the stars fade</span>
                  )}
                </div>
              )}
            </div>
            <div className="hud-panel text-[10px] text-slate-400">
              Shards <span className="text-cyan-300 font-bold">{hud.shards}/{hud.totalShards}</span>
            </div>
          </div>

          {/* bottom-left: speed + boost */}
          <div className="absolute bottom-4 left-4 z-20">
            <div className="hud-panel">
              <div className="text-4xl font-black text-white font-mono">{hud.speedKmh}<span className="text-base text-slate-400 font-normal"> km/h</span></div>
              <div className="w-48 h-2 bg-slate-800 rounded mt-2">
                <div className={`h-full rounded ${hud.boosting ? 'bg-fuchsia-400 shadow-[0_0_12px_rgba(232,121,249,0.9)]' : 'bg-cyan-500'}`} style={{ width: `${hud.boost}%` }} />
              </div>
              <div className="text-[10px] text-slate-400 mt-1">NITRO — hold SHIFT {hud.drift > 0 && <span className="text-yellow-300 ml-2">DRIFT {hud.drift}</span>}</div>
            </div>
          </div>

          {/* bottom-right: keyboard hints (desktop only) */}
          {!isTouch && (
            <div className="absolute bottom-4 right-4 z-20 hud-panel text-[11px] text-slate-400 leading-relaxed">
              <b className="text-slate-200">WASD</b> drive · <b className="text-slate-200">SHIFT</b> nitro · <b className="text-slate-200">SPACE</b> handbrake<br />
              <b className="text-slate-200">E</b> job board · <b className="text-slate-200">H</b> horn · <b className="text-slate-200">C</b> camera · <b className="text-slate-200">ESC</b> menu
            </div>
          )}

          {/* ======== TOUCH CONTROLS (mobile / tablet) ======== */}
          {isTouch && !overlay && (
            <div className="absolute inset-0 z-30 pointer-events-none">
              <div className="absolute inset-x-0 bottom-0 flex justify-between items-end px-4 pb-14">
                {/* steering */}
                <div className="flex gap-3 pointer-events-auto">
                  <TouchBtn engine={engineRef.current} label="◀" hold="a" />
                  <TouchBtn engine={engineRef.current} label="▶" hold="d" />
                </div>
                {/* pedals + actions */}
                <div className="flex flex-col items-end gap-2 pointer-events-auto">
                  <div className="flex gap-2">
                    {hud.nearGarage && <TouchBtn engine={engineRef.current} label="E" tap="e" small />}
                    <TouchBtn engine={engineRef.current} label="📷" tap="c" small />
                    <TouchBtn engine={engineRef.current} label="📯" tap="h" small />
                    <button
                      onClick={() => setOverlay('pause')}
                      className="touch-btn touch-btn-sm"
                      aria-label="Pause"
                    >
                      II
                    </button>
                  </div>
                  <div className="flex gap-2 items-end">
                    <TouchBtn engine={engineRef.current} label="NITRO" hold="shift" wide />
                    <TouchBtn engine={engineRef.current} label="DRIFT" hold=" " />
                    <TouchBtn engine={engineRef.current} label="▲" hold="w" tall />
                    <TouchBtn engine={engineRef.current} label="▼" hold="s" />
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

          {/* E prompt */}
          {hud.nearGarage && !overlay && (
            <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-20 px-4 py-2 bg-cyan-500/20 border border-cyan-400 rounded text-cyan-200 text-sm animate-pulse">
              Press <b>E</b> — open the Job Board
            </div>
          )}

          {/* early access badge */}
          <div className="absolute bottom-1 left-1/2 -translate-x-1/2 z-10 text-[10px] tracking-[0.4em] text-slate-600">
            EARLY ACCESS — progress is saved locally
          </div>

          {/* busted flash + what-to-do summary */}
          {bustedFlash && (
            <div className="absolute inset-0 z-30 bg-red-950/50 flex items-center justify-center pointer-events-none">
              <div className="text-center busted-anim">
                <div className="text-6xl font-black text-red-400 tracking-[0.3em]">BUSTED</div>
                <div className="mt-3 text-slate-200 text-sm max-w-sm mx-auto leading-relaxed">
                  The Patrol hauled you back to the garage and fined 15% of your cash.<br />
                  <span className="text-cyan-300">Next time: when a drone grabs you, MASH SPACE to break free — and never stop moving.</span>
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

      {/* ================= PAUSE ================= */}
      {screen === 'game' && overlay === 'pause' && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <h2 className="text-4xl font-black text-white tracking-[0.3em] mb-8">PAUSED</h2>
          <div className="flex flex-col gap-3 w-64">
            <button onClick={() => setOverlay(null)} className="menu-btn menu-btn-primary">RESUME</button>
            <button onClick={() => setOverlay('shop')} className="menu-btn">GARAGE SHOP</button>
            <button onClick={() => setOverlay('help')} className="menu-btn">HOW TO PLAY</button>
            <button onClick={toggleMute} className="menu-btn">{save.muted ? 'UNMUTE' : 'MUTE'}</button>
            <button onClick={quitToMenu} className="menu-btn">QUIT TO MENU</button>
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
            <div className="flex justify-between items-center mb-1">
              <h2 className="text-2xl font-black text-white tracking-widest">GARAGE SHOP</h2>
              <button onClick={() => setOverlay(null)} className="text-slate-400 hover:text-white text-xl">✕</button>
            </div>
            <div className="text-slate-400 text-xs mb-4">
              Balance: <span className="text-emerald-400 font-bold">${save.cash.toLocaleString()}</span> · Level {save.level}
            </div>

            {/* Full Access banner */}
            {!fullAccess && (
              <button onClick={() => setOverlay('checkout')} className="w-full mb-5 p-4 rounded-xl border border-amber-400/50 bg-gradient-to-r from-amber-500/15 to-fuchsia-500/15 hover:from-amber-500/25 hover:to-fuchsia-500/25 transition-all text-left">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-amber-300 font-black tracking-widest">FULL ACCESS PASS — {FULL_ACCESS_PRICE}</div>
                    <div className="text-slate-300 text-xs mt-1">Unlock every premium skin and all city environments. Founders keep all future themes free.</div>
                  </div>
                  <div className="text-2xl">🔓</div>
                </div>
              </button>
            )}
            {fullAccess && (
              <div className="w-full mb-5 p-3 rounded-xl border border-emerald-400/40 bg-emerald-500/10 text-emerald-300 text-sm text-center">
                🔓 FULL ACCESS owned — all premium content unlocked. Thank you, Founder!
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
                  minLevel={item.minLevel}
                  isOwned={owned(item.id)}
                  isEquipped={save.skin === item.id}
                  isLocked={locked(item)}
                  level={save.level}
                  onBuy={() => buyItem(item.id, item.price, item.premium, item.minLevel)}
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
                  isLocked={locked(item)}
                  level={save.level}
                  onBuy={() => buyItem(item.id, item.price, item.premium, 1)}
                  onEquip={() => equipItem(item.id)}
                />
              ))}
            </div>
            <p className="text-slate-600 text-[11px] mt-5 text-center">
              Early Access build — purchases here use in-game cash. The Full Access Pass is a demo checkout with no real payment.
            </p>
          </div>
        </div>
      )}

      {/* ================= CHECKOUT (DEMO) ================= */}
      {overlay === 'checkout' && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="w-[26rem] max-w-[90vw] bg-slate-900 border border-amber-400/50 rounded-2xl p-6 text-center">
            <div className="text-4xl mb-3">🔓</div>
            <h3 className="text-xl font-black text-white tracking-widest">FULL ACCESS PASS</h3>
            <div className="text-3xl font-black text-amber-300 my-2">{FULL_ACCESS_PRICE}</div>
            <ul className="text-left text-slate-300 text-sm space-y-1 mb-4">
              <li>✦ All premium car skins (Crimson Ghost, Cyber Oni…)</li>
              <li>✦ All city environments (Golden Hour, Acid Rain, Sakura Dusk)</li>
              <li>✦ Every future theme added during Early Access — free</li>
            </ul>
            <div className="bg-amber-500/10 border border-amber-400/30 rounded p-2 text-amber-200/90 text-[11px] mb-4">
              DEMO CHECKOUT — no real payment is processed. At launch this button connects to your real payment provider (Stripe, Steam, etc.).
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  saveRef.current.fullAccess = true
                  commit()
                  engineRef.current?.playBuy()
                  pushToast('FULL ACCESS unlocked — welcome, Founder!', 'good')
                  setOverlay('shop')
                }}
                className="flex-1 py-3 bg-amber-500/20 border border-amber-400 text-amber-200 rounded hover:bg-amber-400/30 font-bold tracking-widest"
              >
                UNLOCK (DEMO)
              </button>
              <button onClick={() => setOverlay('shop')} className="flex-1 py-3 border border-slate-600 text-slate-400 rounded hover:bg-slate-800">
                Not now
              </button>
            </div>
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
              <p><b className="text-cyan-300">Drive & earn.</b> Take courier jobs and races from the Job Board (glowing cyan beam in the city center, press E). Finish fast for bigger payouts.</p>
              <p><b className="text-cyan-300">Explore.</b> 24 data shards glow around the city. Orange ramps pay airtime bonuses. Handbrake drifts around corners pay too.</p>
              <p>
                <b className="text-red-300">The Patrol — read this!</b> Speeding near red patrol drones raises your ★ heat.
                <b> What to do when attacked:</b> keep driving FAST and get 60m+ away from every drone — the stars fade and they give up.
                If a drone sticks to your bumper, <b>never stop</b>. And if one grabs you, <b>mash SPACE rapidly to break free</b> —
                only a stopped, surrounded car gets BUSTED (15% fine, hauled back to the garage). At 3★+ you hear sirens; drones get faster every star.
              </p>
              <p><b className="text-cyan-300">Spend & customize.</b> Cash buys car skins. The Full Access Pass unlocks premium skins and entire city environments (this build demos it for free).</p>
              <div className="text-slate-500 text-xs pt-2 border-t border-slate-800">
                Controls: WASD/arrows drive · SHIFT nitro · SPACE handbrake · E job board · H horn · C camera · ESC pause
              </div>
            </div>
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
}) {
  const cls = `touch-btn${props.small ? ' touch-btn-sm' : ''}${props.wide ? ' touch-btn-wide' : ''}${props.tall ? ' touch-btn-tall' : ''}${props.mash ? ' touch-btn-mash' : ''}`
  const start = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    if (!props.engine) return
    if (props.hold) props.engine.touchDown(props.hold)
    if (props.tap) props.engine.touchTap(props.tap)
  }
  const end = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
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

// ---------- Shop item card ----------
function ShopCard(props: {
  name: string
  desc: string
  swatch: number
  glow: number
  price: number
  premium: boolean
  minLevel: number
  isOwned: boolean
  isEquipped: boolean
  isLocked: boolean
  level: number
  onBuy: () => void
  onEquip: () => void
}) {
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`
  const levelBlocked = props.level < props.minLevel
  return (
    <div className={`relative rounded-xl border p-3 bg-slate-800/60 transition-all ${props.isEquipped ? 'border-cyan-400 shadow-[0_0_16px_rgba(34,211,238,0.35)]' : 'border-slate-700 hover:border-slate-500'}`}>
      {props.premium && (
        <div className="absolute -top-2 -right-2 bg-amber-500 text-black text-[10px] font-black px-2 py-0.5 rounded-full">PREMIUM</div>
      )}
      <div className="h-14 rounded-lg mb-2 flex items-end justify-center" style={{ background: `linear-gradient(135deg, ${hex(props.swatch)}, #0b0d14)` }}>
        <div className="w-24 h-2 rounded-full mb-2" style={{ background: hex(props.glow), boxShadow: `0 0 14px ${hex(props.glow)}` }} />
      </div>
      <div className="text-white font-bold text-sm">{props.name}</div>
      <div className="text-slate-400 text-[11px] mt-0.5 leading-snug min-h-[2rem]">{props.desc}</div>
      <div className="mt-2">
        {props.isEquipped ? (
          <div className="text-center text-cyan-300 text-xs font-bold py-1.5 border border-cyan-500/50 rounded">EQUIPPED</div>
        ) : props.isOwned ? (
          <button onClick={props.onEquip} className="w-full py-1.5 text-xs font-bold border border-slate-500 text-slate-200 rounded hover:bg-slate-700">EQUIP</button>
        ) : props.isLocked ? (
          <button onClick={props.onBuy} className="w-full py-1.5 text-xs font-bold border border-amber-500/60 text-amber-300 rounded hover:bg-amber-500/10">🔒 FULL ACCESS</button>
        ) : levelBlocked ? (
          <div className="text-center text-slate-500 text-xs py-1.5 border border-slate-800 rounded">Requires level {props.minLevel}</div>
        ) : (
          <button onClick={props.onBuy} className="w-full py-1.5 text-xs font-bold border border-emerald-500/60 text-emerald-300 rounded hover:bg-emerald-500/10">
            BUY — ${props.price.toLocaleString()}
          </button>
        )}
      </div>
    </div>
  )
}
