// ============================================================
// NEON HARBOR — interactive "How to Play" guide.
// Replaces the old text-wall manual with an AAA-style FTUE:
// one mechanic per screen, a live animated demo stage, and
// try-it-yourself steps that listen for the real inputs
// (hold W / pedal to drive, tap the job board, mash to escape).
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import './how-to-play.css'

interface Props {
  isTouch: boolean
  onClose: () => void
}

const STEP_TITLES = [
  'ONE CITY, ONE NIGHT',
  'DRIVE',
  'NITRO & DRIFT',
  'TAKE A JOB',
  'THE PATROL',
  'EXPLORE & EARN',
  "YOU'RE READY",
]
export default function HowToPlay({ isTouch, onClose }: Props) {
  const [step, setStep] = useState(0)
  const [dir, setDir] = useState<1 | -1>(1)
  // try-it state
  const [gas, setGas] = useState(0)
  const [driveDone, setDriveDone] = useState(false)
  const [held, setHeld] = useState(false)
  const [jobAccepted, setJobAccepted] = useState(false)
  const [meter, setMeter] = useState(0)
  const [escaped, setEscaped] = useState(false)

  const heldRef = useRef(false)
  const audioRef = useRef<AudioContext | null>(null)

  // ---------- tiny synth for feedback blips (created on first user gesture) ----------
  const tone = useCallback((freq: number, dur = 0.09, type: OscillatorType = 'square', gain = 0.035, when = 0) => {
    try {
      if (!audioRef.current) {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!AC) return
        audioRef.current = new AC()
      }
      const ctx = audioRef.current
      if (ctx.state === 'suspended') void ctx.resume()
      const t0 = ctx.currentTime + when
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = type
      o.frequency.value = freq
      g.gain.setValueAtTime(gain, t0)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
      o.connect(g).connect(ctx.destination)
      o.start(t0)
      o.stop(t0 + dur)
    } catch {
      /* audio blocked — visuals still carry the feedback */
    }
  }, [])
  const chime = useCallback(() => {
    tone(660, 0.1, 'square', 0.04)
    tone(990, 0.16, 'square', 0.035, 0.09)
  }, [tone])

  const go = useCallback(
    (next: number) => {
      setDir(next > step ? 1 : -1)
      setStep(Math.max(0, Math.min(STEP_TITLES.length - 1, next)))
      tone(340, 0.05, 'triangle', 0.025)
    },
    [step, tone],
  )

  const mash = useCallback(() => {
    if (escaped) return
    setMeter((m) => Math.min(1, m + 0.17))
    tone(220 + Math.random() * 80, 0.04, 'square', 0.03)
  }, [escaped, tone])

  // ---------- drive: fill the speed bar while the input is held ----------
  useEffect(() => {
    if (step !== 1 || driveDone) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = now - last
      last = now
      if (heldRef.current) setGas((g) => Math.min(1, g + dt / 1100))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [step, driveDone])

  useEffect(() => {
    if (gas >= 1 && !driveDone) {
      setDriveDone(true)
      chime()
    }
  }, [gas, driveDone, chime])

  // ---------- patrol: the escape meter drains, mash to fill it ----------
  useEffect(() => {
    if (step !== 4 || escaped) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      setMeter((m) => Math.max(0, m - dt * 0.22))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [step, escaped])

  useEffect(() => {
    if (meter >= 1 && !escaped) {
      setEscaped(true)
      chime()
    }
  }, [meter, escaped, chime])

  // ---------- keyboard: ESC closes, W/↑ drives, SPACE mashes ----------
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (k === 'escape') {
        onClose()
        return
      }
      if (step === 1 && (k === 'w' || k === 'arrowup')) {
        e.preventDefault()
        if (!heldRef.current) tone(180, 0.06, 'sawtooth', 0.02)
        heldRef.current = true
        setHeld(true)
      }
      if (step === 4 && k === ' ') {
        e.preventDefault()
        if (!e.repeat) mash()
      }
    }
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (k === 'w' || k === 'arrowup') {
        heldRef.current = false
        setHeld(false)
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [step, onClose, mash, tone])

  const holdStart = (e: React.PointerEvent) => {
    e.preventDefault()
    heldRef.current = true
    setHeld(true)
    tone(180, 0.06, 'sawtooth', 0.02)
  }
  const holdEnd = () => {
    heldRef.current = false
    setHeld(false)
  }

  const isLast = step === STEP_TITLES.length - 1

  return (
    <div className="htp-shell" role="dialog" aria-label="How to play Neon Harbor">
      <div className="htp-card font-game">
        {/* header */}
        <div className="htp-head">
          <div>
            <div className="htp-kicker">HOW TO PLAY · {step + 1}/{STEP_TITLES.length}</div>
            <div className="htp-title">{STEP_TITLES[step]}</div>
          </div>
          <button className="htp-close" onClick={onClose} aria-label="Close guide">✕</button>
        </div>

        {/* progress dots — ✓ green once a try-it is beaten */}
        <div className="htp-dots">
          {STEP_TITLES.map((t, i) => {
            const done =
              (i === 1 && driveDone) || (i === 3 && jobAccepted) || (i === 4 && escaped)
            return (
              <button
                key={t}
                className={`htp-dot${i === step ? ' htp-dot-on' : ''}${done ? ' htp-dot-done' : ''}`}
                onClick={() => go(i)}
                aria-label={`Step ${i + 1}: ${t}`}
              />
            )
          })}
        </div>

        <div key={step} className={`htp-step${dir === -1 ? ' htp-step-back' : ''}`}>
          {step === 0 && <LoopDemo />}
          {step === 1 && (
            <DriveDemo gas={gas} done={driveDone} held={held} isTouch={isTouch} onHoldStart={holdStart} onHoldEnd={holdEnd} />
          )}
          {step === 2 && <DriftDemo />}
          {step === 3 && (
            <JobsDemo
              accepted={jobAccepted}
              onAccept={() => {
                setJobAccepted(true)
                chime()
              }}
            />
          )}
          {step === 4 && <PatrolDemo meter={meter} escaped={escaped} onMash={mash} isTouch={isTouch} />}
          {step === 5 && <ExploreDemo />}
          {step === 6 && <ReadyDemo isTouch={isTouch} />}

          {/* per-step copy — one idea, two lines max */}
          <div className="htp-copy">
            {step === 0 && (
              <>
                <div className="htp-lead">Take jobs. Earn cash. Unlock the city.</div>
                <div className="htp-sub">
                  Neon Harbor is a night of <b>courier runs, taxi fares and street races</b> — level up to open the gated districts, and out-drive the Patrol when the ★ heat lights up.
                </div>
              </>
            )}
            {step === 1 && (
              <>
                <div className="htp-lead">
                  {isTouch ? (
                    <>Try it — <b>press &amp; hold the pedal</b> (in game: push the joystick UP)</>
                  ) : (
                    <>Try it — <b>hold <span className="key-cap">W</span></b> and don't let go</>
                  )}
                </div>
                <div className="htp-sub">
                  {isTouch ? 'Steer by swiping the right half of the screen — flick for sharp turns.' : 'Steer with A / D or the arrow keys. The guide waits for you — floor it!'}
                </div>
              </>
            )}
            {step === 2 && (
              <>
                <div className="htp-lead">Slide corners to charge your boost.</div>
                <div className="htp-sub">
                  {isTouch ? (
                    <>Tap <b>DRIFT</b> mid-turn to slide — drifting refills <b>NITRO</b>, then fire it on the straights.</>
                  ) : (
                    <>Hold <span className="key-cap">SPACE</span> mid-turn to drift — drifting refills <span className="key-cap">SHIFT</span> nitro. Fire it on the straights.</>
                  )}
                </div>
              </>
            )}
            {step === 3 && (
              <>
                <div className="htp-lead">Try it — <b>tap the glowing JOB BOARD</b></div>
                <div className="htp-sub">
                  In the city, follow the tall <b>cyan beam</b> and {isTouch ? 'tap E' : 'press E'} at the garage. The blue route on your minimap always points to work. Finish fast for bigger payouts.
                </div>
              </>
            )}
            {step === 4 && (
              <>
                <div className="htp-lead">
                  {escaped ? (
                    <>You broke free. That's the whole trick.</>
                  ) : (
                    <>A drone has you! <b>MASH {isTouch ? 'THE BUTTON' : <span className="key-cap">SPACE</span>}</b> to break free</>
                  )}
                </div>
                <div className="htp-sub">
                  Speeding near red drones raises your ★ heat. Outrun them — <b>never stop</b> — and if one grabs you, mash. Only a stopped, surrounded car gets BUSTED (15% fine).
                </div>
              </>
            )}
            {step === 5 && (
              <>
                <div className="htp-lead">The city pays for style.</div>
                <div className="htp-sub">
                  <b>24 data shards</b> glow around town, <b>orange ramps</b> pay airtime bonuses, and drift chains stack cash. Locked districts open as you level up.
                </div>
              </>
            )}
            {step === 6 && (
              <>
                <div className="htp-chips">
                  <span className="htp-chip htp-chip-cyan">{isTouch ? 'JOYSTICK + SWIPE' : 'WASD DRIVE'}</span>
                  <span className="htp-chip htp-chip-fuchsia">{isTouch ? 'BOLT = NITRO' : 'SHIFT NITRO'}</span>
                  <span className="htp-chip htp-chip-amber">{isTouch ? 'SKID = DRIFT' : 'SPACE DRIFT'}</span>
                  <span className="htp-chip htp-chip-green">{isTouch ? 'E AT THE BEAM' : 'E JOB BOARD'}</span>
                  <span className="htp-chip htp-chip-red">PATROL? NEVER STOP</span>
                </div>
                <div className="htp-sub">
                  {isTouch
                    ? 'Map icon = tactical view · pause is top-center · the camera appears after any win'
                    : 'P photo mode · C camera · H horn · ESC pause · gamepad supported'}
                </div>
              </>
            )}
          </div>
        </div>

        {/* footer nav */}
        <div className="htp-foot">
          {step > 0 ? (
            <button className="htp-nav" onClick={() => go(step - 1)}>← BACK</button>
          ) : (
            <button className="htp-skip" onClick={onClose}>SKIP GUIDE</button>
          )}
          {step > 0 && <button className="htp-skip" onClick={onClose}>SKIP</button>}
          {isLast ? (
            <button className="htp-nav htp-nav-primary htp-nav-start" onClick={onClose}>
              HIT THE STREETS →
            </button>
          ) : (
            <button className="htp-nav htp-nav-primary" onClick={() => go(step + 1)}>
              NEXT →
            </button>
          )}
        </div>

        {isLast && (
          <div className="htp-credits">Character models: Quaternius (CC0) · City &amp; cars: Kenney (CC0)</div>
        )}
      </div>
    </div>
  )
}

// ============================================================
// Demo stages — pure CSS/SVG animations, no game engine needed
// ============================================================

/** The little side-view demo car used by several stages. */
function DemoCar(props: { style?: React.CSSProperties; drift?: boolean; flame?: boolean; shake?: boolean; className?: string }) {
  return (
    <div className={`htp-car${props.drift ? ' htp-car-drift' : ''}${props.shake ? ' htp-shake' : ''}${props.className ? ` ${props.className}` : ''}`} style={props.style}>
      <div className="htp-car-glow" />
      <div className="htp-car-cabin" />
      <div className="htp-car-body" />
      <div className="htp-car-light" />
      {props.flame && <div className="htp-car-flame" />}
      <div className="htp-wheel htp-wheel-f" />
      <div className="htp-wheel htp-wheel-b" />
    </div>
  )
}

/** Step 0 — the gameplay loop on a stylized minimap. */
function LoopDemo() {
  return (
    <div className="htp-stage">
      <svg className="htp-map" viewBox="0 0 320 130" preserveAspectRatio="none">
        <defs>
          <pattern id="htpGrid" width="26" height="26" patternUnits="userSpaceOnUse">
            <path d="M26 0H0V26" fill="none" stroke="rgba(34,211,238,0.08)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="320" height="130" fill="url(#htpGrid)" />
        <path
          id="htpLoop"
          d="M40,95 H130 V35 H225 V95 H280"
          fill="none"
          stroke="rgba(34,211,238,0.85)"
          strokeWidth="2.5"
          className="htp-route"
        />
        <circle r="4.5" fill="#fff" style={{ filter: 'drop-shadow(0 0 6px #22d3ee)' }}>
          <animateMotion dur="5s" repeatCount="indefinite" rotate="auto">
            <mpath href="#htpLoop" />
          </animateMotion>
        </circle>
        <rect x="272" y="86" width="16" height="18" rx="3" fill="rgba(34,211,238,0.25)" stroke="#22d3ee" strokeWidth="1.5" />
        <circle cx="130" cy="35" r="5" fill="none" stroke="#f0abfc" strokeWidth="2" />
        <circle cx="225" cy="65" r="5" fill="none" stroke="#34d399" strokeWidth="2" />
      </svg>
      <div className="htp-chips" style={{ position: 'absolute', bottom: '0.45rem', left: 0, right: 0, margin: 0 }}>
        <span className="htp-chip htp-chip-cyan">JOBS</span>
        <span className="htp-chip htp-chip-green">CASH + XP</span>
        <span className="htp-chip htp-chip-fuchsia">UNLOCK DISTRICTS</span>
        <span className="htp-chip htp-chip-red">OUTRUN THE ★</span>
      </div>
    </div>
  )
}

/** Step 1 — hold to accelerate; the stage reacts to the real input. */
function DriveDemo(props: {
  gas: number
  done: boolean
  held: boolean
  isTouch: boolean
  onHoldStart: (e: React.PointerEvent) => void
  onHoldEnd: () => void
}) {
  const kmh = Math.round(props.gas * 168)
  return (
    <>
      <div className="htp-stage">
        {/* speed streaks fade in with speed */}
        {[18, 34, 52, 70].map((top, i) => (
          <div
            key={i}
            className="htp-streak"
            style={{
              top: `${top}%`,
              left: `${8 + i * 22}%`,
              width: `${3 + (i % 3)}rem`,
              opacity: props.gas * 0.9,
              animationDuration: `${0.62 - props.gas * 0.4}s`,
            }}
          />
        ))}
        <div className="htp-road" style={{ '--road': `${1.15 - props.gas * 0.9}s` } as React.CSSProperties} />
        <DemoCar
          style={
            {
              '--spin': `${Math.max(0.12, 0.75 - props.gas * 0.62)}s`,
              transform: `translateX(${props.gas * 14}%) scale(${1 + props.gas * 0.06})`,
            } as React.CSSProperties
          }
        />
        <div className="htp-speedo" style={{ position: 'absolute', right: '0.8rem', top: '0.55rem' }}>
          {kmh}
          <span style={{ fontSize: '0.55rem', color: '#64748b', letterSpacing: '0.15em' }}> KM/H</span>
        </div>
        {props.done && (
          <div style={{ position: 'absolute', left: '50%', top: '0.6rem', transform: 'translateX(-50%)' }}>
            <span className="htp-success" style={{ marginTop: 0 }}>✓ NAILED IT</span>
          </div>
        )}
      </div>
      <div className="htp-try">
        {props.isTouch ? (
          <button
            className={`htp-try-key${props.held ? ' htp-try-key-held' : ''}`}
            onPointerDown={props.onHoldStart}
            onPointerUp={props.onHoldEnd}
            onPointerLeave={props.onHoldEnd}
            onPointerCancel={props.onHoldEnd}
            onContextMenu={(e) => e.preventDefault()}
          >
            GAS
          </button>
        ) : (
          <span className={`htp-try-key${props.held ? ' htp-try-key-held' : ''}`}>HOLD W</span>
        )}
        <div className="htp-meter">
          <div className="htp-meter-fill" style={{ width: `${props.gas * 100}%` }} />
        </div>
      </div>
    </>
  )
}

/** Step 2 — drifting car loop with smoke, nitro flame, refilling boost bar. */
function DriftDemo() {
  return (
    <div className="htp-stage">
      <div className="htp-road" />
      <DemoCar drift flame />
      {/* smoke puffs behind the sliding car */}
      <div className="htp-smoke" style={{ left: '34%', bottom: '1.5rem' }} />
      <div className="htp-smoke" style={{ left: '31%', bottom: '1.9rem', animationDelay: '0.35s' }} />
      <div className="htp-smoke" style={{ left: '36%', bottom: '1.2rem', animationDelay: '0.7s' }} />
      <div className="htp-cash-pop" style={{ left: '58%', bottom: '3.4rem' }}>+$45 DRIFT</div>
      <div style={{ position: 'absolute', right: '0.8rem', top: '0.55rem', width: '7rem' }}>
        <div style={{ fontSize: '0.55rem', letterSpacing: '0.2em', color: '#f0abfc', fontWeight: 800, marginBottom: '0.2rem' }}>NITRO</div>
        <div className="htp-meter" style={{ maxWidth: '100%' }}>
          <div className="htp-meter-fill htp-nitro-loop" />
        </div>
      </div>
    </div>
  )
}

/** Step 3 — tap the job board to accept a courier run. */
function JobsDemo(props: { accepted: boolean; onAccept: () => void }) {
  return (
    <div className="htp-stage">
      <svg className="htp-map" viewBox="0 0 320 130" preserveAspectRatio="none">
        <defs>
          <pattern id="htpGridJobs" width="26" height="26" patternUnits="userSpaceOnUse">
            <path d="M26 0H0V26" fill="none" stroke="rgba(34,211,238,0.08)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="320" height="130" fill="url(#htpGridJobs)" />
        {props.accepted && (
          <path
            id="htpJobRoute"
            d="M36,108 H150 V52 H236"
            fill="none"
            stroke="rgba(52,211,153,0.9)"
            strokeWidth="3"
            className="htp-route"
          />
        )}
        <circle cx="36" cy="108" r="5" fill="#fff" style={{ filter: 'drop-shadow(0 0 6px #22d3ee)' }} />
        <rect x="236" y="40" width="22" height="24" rx="4" fill="rgba(34,211,238,0.22)" stroke="#22d3ee" strokeWidth="1.6" />
      </svg>
      <div className="htp-beam" style={{ right: '13%' }} />
      <div className="htp-beam-spark" style={{ right: '13.4%' }} />
      <div className="htp-beam-spark" style={{ right: '12.6%', animationDelay: '0.9s' }} />
      {!props.accepted ? (
        <button className="htp-board-btn" style={{ right: '5%', bottom: '52%' }} onClick={props.onAccept}>
          ▲ TAP TO ACCEPT
        </button>
      ) : (
        <div className="htp-mission-card">✓ COURIER RUN — deliver the package · <b style={{ color: '#34d399' }}>$240</b></div>
      )}
    </div>
  )
}

/** Step 4 — the drone grab: mash the real input to break free. */
function PatrolDemo(props: { meter: number; escaped: boolean; onMash: () => void; isTouch: boolean }) {
  return (
    <>
      <div className="htp-stage">
        <div className="htp-road" />
        <DemoCar
          shake={!props.escaped}
          style={
            props.escaped
              ? { transform: 'translateX(160%)', transition: 'transform 0.8s cubic-bezier(0.5,0,0.9,0.4)' }
              : undefined
          }
        />
        <div
          className="htp-drone"
          style={
            props.escaped
              ? { left: '46%', bottom: '3rem', transform: 'translate(9rem, -6rem) scale(0.5)', opacity: 0 }
              : { left: 'calc(38% + 1.4rem)', bottom: '3rem' }
          }
        >
          <div className="htp-drone-eye" />
        </div>
        {!props.escaped && (
          <div style={{ position: 'absolute', left: '50%', top: '0.55rem', transform: 'translateX(-50%)', color: '#fca5a5', fontWeight: 900, fontSize: '0.72rem', letterSpacing: '0.2em', textShadow: '0 0 12px rgba(248,113,113,0.8)' }}>
            ★ GRABBED ★
          </div>
        )}
        {props.escaped && (
          <div style={{ position: 'absolute', left: '50%', top: '0.6rem', transform: 'translateX(-50%)' }}>
            <span className="htp-success" style={{ marginTop: 0 }}>✓ ESCAPED</span>
          </div>
        )}
      </div>
      {!props.escaped && (
        <div className="htp-try">
          <button
            className="htp-try-key htp-try-key-red"
            onPointerDown={(e) => {
              e.preventDefault()
              props.onMash()
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {props.isTouch ? 'MASH!' : 'SPACE'}
          </button>
          <div className="htp-meter">
            <div className="htp-meter-fill htp-meter-fill-red" style={{ width: `${props.meter * 100}%` }} />
          </div>
        </div>
      )}
    </>
  )
}

/** Step 5 — shards, ramps and cash loops. */
function ExploreDemo() {
  return (
    <div className="htp-stage">
      <div className="htp-road" />
      <DemoCar />
      <div className="htp-shard" style={{ left: '62%', bottom: '3.1rem' }} />
      <div className="htp-shard" style={{ left: '74%', bottom: '4.1rem', animationDelay: '0.5s' }} />
      <div className="htp-shard" style={{ left: '86%', bottom: '3rem', animationDelay: '1s' }} />
      <div className="htp-cash-pop" style={{ left: '62%', bottom: '4.2rem' }}>+1 SHARD</div>
      <div className="htp-cash-pop" style={{ left: '76%', bottom: '5rem', animationDelay: '0.7s' }}>+$80 AIRTIME</div>
    </div>
  )
}

/** Step 6 — recap, no stage: a pulsing "ready" emblem. */
function ReadyDemo({ isTouch }: { isTouch: boolean }) {
  return (
    <div className="htp-stage" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'clamp(4.5rem, 14vh, 6rem)' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '1.5rem', fontWeight: 900, color: '#fff', letterSpacing: '0.1em', textShadow: '0 0 18px rgba(34,211,238,0.8)' }}>
          FIRST NIGHT <span style={{ color: '#22d3ee' }}>7/7</span>
        </div>
        <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '0.25rem' }}>
          The live guide continues in-game — follow the card at the top{isTouch ? '' : ' · press T anytime to skip it'}
        </div>
      </div>
    </div>
  )
}
