// ============================================================
// NEON HARBOR — 3D game engine (Three.js)
// Procedural neon port city with bloom post-processing,
// ambient traffic, missions, Harbor Patrol heat system.
// ============================================================

import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { getSkin, getTheme, ACHIEVEMENTS, DISTRICTS, districtAt, ENGINE_MUL, NITRO_REGEN_MUL, NITRO_DRAIN_MUL, TIRES_MUL, ARMOR_MUL, LAUNCH_MUL, HORN_RANGE, WORLD_ZONES, zoneAt, breakdownById, rollBreakdown, breakdownCost, breakdownMuls, type WorldZone } from './content'
import { CREW_STEPS, HOME_TURF_BONUS, crewFor, crewRep, districtOwned, districtsOwned } from './crews'
import { grantXp, xpForLevel, type SaveData, type ShiftGoal, dailyKey, weekKey } from './save'
import { Synth } from './audio'
import { cloneCar, cloneCharacter, CITY_BY_KIND, type GameAssets } from './assets'

// ---------- Public types shared with the React UI ----------
export interface HudMission {
  kind: 'delivery' | 'race' | 'taxi' | 'getaway'
  name: string
  timer: number // seconds left; -1 = no countdown (getaway)
  dist: number
  stage: string
  /** Live risk–reward (Phase 1): payout estimate and the multipliers applied to it */
  payoutEst: number
  heatMult: number
  credPct: number
}

export interface HudState {
  speedKmh: number
  cash: number
  xp: number
  level: number
  xpNext: number
  heat: number
  heatStars: number
  bustedProgress: number
  boost: number
  shards: number
  totalShards: number
  drift: number
  chainMult: number
  /** Street Cred live chain: unbanked cred, current ×mult, bank timer 0..1. Null when no chain. */
  cred: { chain: number; mult: number; idle01: number } | null
  /** true when a chaser (drone/cruiser) is close but hasn't grabbed you yet — HUD shows escape advice */
  pursued: boolean
  /** first-time onboarding: current objective, or null when tutorial is finished */
  tutorial: { step: number; total: number; title: string; hint: string } | null
  mission: HudMission | null
  /** map contract beacon in accept range (free-roam only): job + modifier chips */
  marker: { kind: string; mods: string[] } | null
  /** Night Shift goal set — null while the First Night guide is still running */
  shift: { done: number; total: number; goals: { label: string; progress: number; target: number; done: boolean }[] } | null
  nearGarage: boolean
  busted: boolean
  boosting: boolean
  /** body damage 0-100 — HUD wrench bar; heavy damage bleeds speed, 100 = WRECKED */
  damage: number
  /** car exploded at 100% damage — game over overlay, tow to garage */
  wrecked: boolean
  /** the hit that did the most recent damage — shown on the WRECKED card so the
      crash that killed the car is never a mystery ("killing blow: wall, ~62 km/h") */
  lastHitKmh: number
  lastHitCause: string
  /** car is wedged (gas held but no movement) — HUD offers the reset recovery */
  stuck: boolean
  /** World Circuit (v2): current city zone + odometer progress */
  zone: { id: string; name: string; landmark: string; unlockLevel: number; index: number; lap: number; kmInto: number; kmToNext: number }
  worldKm: number
  /** broken part id (see BREAKDOWNS) — null when nothing is broken */
  breakdown: string | null
}

export interface EngineHooks {
  getSave(): SaveData
  commit(): void
  onHud(h: HudState): void
  onToast(msg: string, kind: 'info' | 'cash' | 'warn' | 'good'): void
  onBusted(): void
  onWrecked(): void
  onLevelUp(level: number): void
  onMissionDone(name: string, reward: number): void
  onPressE(): void
  onPauseToggle?(): void
  onPhotoToggle?(): void
  /** one-time progress milestones for vplay.gg (deduped per save in App) */
  onMilestone?(id: string): void
  /** A leaderboard score for vplay.gg: daily = payout (higher wins), weekly = seconds (lower wins). */
  onScore?(board: 'daily' | 'weekly', key: string, value: number): void
  /** World Circuit (v2): the world transformed into a new city zone. */
  onZoneEntered?(zoneId: string): void
}

// ---------- World layout constants ----------
const N = 9 // blocks per side
const BLOCK = 30
const ROAD = 14
const CELL = BLOCK + ROAD
const SIZE = N * BLOCK + (N + 1) * ROAD // 410
const HALF = SIZE / 2
const GARAGE_I = 4
const GARAGE_J = 4
const TOTAL_SHARDS = 24

const MAX_SPEED = 40 // m/s (~144 km/h)
const BOOST_MULT = 1.55
const ACCEL = 26
const BRAKE = 36
const CAR_R = 1.6
// Street Cred: chain cred thresholds that step the multiplier ×2 → ×5
const CRED_STEPS = [100, 250, 500, 900]

// ---------- First-night onboarding (shown once, skippable with T) ----------
const TUTORIAL_STEPS: { title: string; hint: string }[] = [
  { title: 'HOLD W — accelerate', hint: 'WASD or arrow keys drive the car. Get moving!' },
  { title: 'STEER with A / D', hint: 'Tap A or D while moving to turn. Try a corner.' },
  { title: 'HOLD SHIFT — nitro boost', hint: 'Nitro recharges on its own. Use it on straights.' },
  { title: 'DRIFT — hold SPACE in a turn', hint: 'Handbrake + steering slides the car. Drifts earn cash chains.' },
  { title: 'Reach the GARAGE', hint: 'Follow the tall cyan beam in the city center.' },
  { title: 'Press E at the garage', hint: 'The Job Board has courier runs, taxi fares, street races and getaway contracts.' },
  { title: 'Earn your first payout', hint: 'Finish the job — or grab a cyan shard / green crate on the way.' },
]

interface AABB {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

// Sky zenith color per theme id — used by smooth theme transitions (paintTransitionSky).
const SKY_TOPS: Record<string, number> = {
  day: 0x3f8ef0,
  golden: 0xc96a2e,
  sakura: 0x4a2b52,
  midnight: 0x0b1730,
  acid: 0x0a1410,
}

// Numeric snapshot of every theme-driven light/material parameter, blended during transitions.
interface ThemeMix {
  skyTop: number
  sky: number
  fog: number
  fogDensity: number
  ambient: number
  ambientI: number
  moon: number
  moonI: number
  ground: number
  water: number
  cityEm: number
  skyEm: number
  headSpot: number
  winColor: number
  lens: number
  pool: number
  glow: number
  track: number
  foamNight: number
  cloudColor: number
  cloudOpacity: number
  /** lane-marking paint (pale at night, dark by day) + sidewalk slab color */
  lane: number
  walk: number
}

interface Drone {
  mesh: THREE.Group
  pos: THREE.Vector3
  vel: THREE.Vector3
  wp: THREE.Vector3
  bob: number
}

interface Shard {
  id: string
  mesh: THREE.Mesh
  taken: boolean
}

interface Ramp {
  x: number
  z: number
  angle: number
}

interface TrafficCar {
  mesh: THREE.Group
  axis: 'x' | 'z'
  lane: number
  dir: 1 | -1
  speed: number
  cruise: number
  nmCooldown: number
  /** horn yield: drift toward the road edge for this many seconds */
  yieldT: number
  /** world-circuit city this car belongs to — only the active city's cars drive */
  zone: string
}

type Mission =
  | { kind: 'delivery'; stage: 'pickup' | 'deliver'; a: THREE.Vector3; b: THREE.Vector3; timer: number; name: string; mods: ModId[]; damageHits: number }
  | { kind: 'race'; cps: THREE.Vector3[]; idx: number; timer: number; total: number; name: string; mods: ModId[]; damageHits: number }
  | { kind: 'taxi'; stage: 'pickup' | 'ride'; a: THREE.Vector3; b: THREE.Vector3; timer: number; name: string; passenger: THREE.Group | null; dist: number; mods: ModId[]; damageHits: number; late: boolean }
  | { kind: 'getaway'; heat0: number; name: string; mods: ModId[]; damageHits: number }

// Contract modifiers (Phase 1, step 3): change HOW you drive, not just the pay
type ModId = 'rush' | 'fragile' | 'hot' | 'vip' | 'clean'
const MOD_INFO: Record<ModId, { chip: string; blurb: string }> = {
  rush: { chip: '⚡ RUSH', blurb: 'timer −30%, pay +50%' },
  fragile: { chip: '🥚 FRAGILE', blurb: 'every crash −10% payout' },
  hot: { chip: '🔥 HOT CARGO', blurb: 'starts at ★1, pay +30% (+ heat mult)' },
  vip: { chip: '🎩 VIP', blurb: 'no crashes = double tip' },
  clean: { chip: '🌙 CLEAN RUN', blurb: 'finish undamaged: +25%' },
}
const JOB_COLORS: Record<Mission['kind'], number> = { delivery: 0x22d3ee, taxi: 0xfbbf24, race: 0xf472b6, getaway: 0xf87171 }

/** A contract marker on the map: small colored beam, drive in + E to accept. */
interface ContractMarker {
  id: number
  kind: Mission['kind']
  mods: ModId[]
  pos: THREE.Vector3
  expiresAt: number // engine time
  mesh: THREE.Group
}

function blockOrigin(i: number): number {
  return -HALF + ROAD + i * CELL
}

function seededRand(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

// ---------- Engine ----------
export class GameEngine {
  private renderer: THREE.WebGLRenderer
  private canvas: HTMLCanvasElement
  private composer: EffectComposer
  private bloomPass!: UnrealBloomPass
  // MOB-3: FPS watchdog — on touch devices, sustained low FPS steps quality
  // down (display scale first, then bloom + shadow resolution). Never re-raises.
  private autoQuality = false
  /** Phones and tablets: a lighter render setup from the very first frame
      (fewer lights, one shadow map, smaller buffers). Every extra light is
      paid by every pixel of every lit surface, and mobile GPUs can't afford
      the desktop rig — waiting for the watchdog meant seconds of stutter. */
  private lowPower =
    typeof window !== 'undefined' &&
    (window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window)
  private fpsThreshold = 42
  private qualityLevel = 0
  private fpsAccum = 0
  private fpsFrames = 0
  private fpsWindow = 0
  // MOB-1: analog touch input from the virtual joystick (null = keyboard/digital)
  private analogSteer: number | null = null
  // CoD-style swipe steering: horizontal drag on the right half of the screen.
  // Takes priority over joystick tilt while a swipe is in progress.
  private swipeSteer: number | null = null
  private analogThrottle: number | null = null
  // Gamepad (Xbox/PS/Switch controller): polled every frame, overrides nothing
  // until a stick/pedal actually moves — keyboard and touch keep working
  private padSteer: number | null = null
  private padThrottle: number | null = null
  private padHandbrake = false
  private padBoost = false
  private padAnnounced = false
  private padPrev: boolean[] = []
  // Photo mode: freezes the world, orbits the car, captures stills
  photoMode = false
  // While the React tap-through onboarding tour is on screen, the FIRST NIGHT
  // engine tutorial stays hidden AND frozen — one onboarding at a time.
  onboardingActive = false
  // UI platform flag (wording only): true = touch device, false = desktop.
  uiTouch = false
  private photoYaw = 0
  private photoPitch = 0.35
  private photoDist = 9
  private photoDragging = false
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private mmCanvas: HTMLCanvasElement
  private mmCtx: CanvasRenderingContext2D
  private mmBase: HTMLCanvasElement
  private hooks: EngineHooks
  private synth = new Synth()

  private raf = 0
  private timer = new THREE.Timer()
  private disposed = false
  private paused = false
  private attract = true // cinematic orbit (menus) vs gameplay chase cam
  private hudTimer = 0
  private time = 0

  // Input
  private keys = new Set<string>()

  // Car state
  private car = new THREE.Group()
  private bodyMat = new THREE.MeshPhysicalMaterial({
    color: 0x8a93a6,
    metalness: 0.72,
    roughness: 0.2,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    reflectivity: 0.9,
  }) // candy-clearcoat paint — neon signs slide across the body at night
  private glowLight = new THREE.PointLight(0x22d3ee, 2.2, 12)
  private headL: THREE.SpotLight
  private headR: THREE.SpotLight
  /** One true shadow-casting headlight — lights the road surface ahead at night. */
  private headSpot: THREE.SpotLight
  private wheels: THREE.Mesh[] = []
  private taillightMat = new THREE.MeshBasicMaterial({ color: 0x881122 })
  private flameL: THREE.Mesh
  private flameR: THREE.Mesh
  private trailGeom = new THREE.BufferGeometry()
  private trailPos: Float32Array
  private trailLine: THREE.Line
  private trailHistory: THREE.Vector3[] = []
  private pos = new THREE.Vector3(0, 0, 20)
  private vel = new THREE.Vector3()
  private heading = Math.PI
  private stuckTime = 0
  private stuckLatch = 0 // keeps the RESET offer alive briefly after gas is released
  private stuckRef = new THREE.Vector3() // position sample for bounce-proof stuck detection
  private stuckRefTimer = 0
  private stuckAuto = 0 // continuous wedge time → triggers auto-respawn
  private stuckEpStart = new THREE.Vector3() // episode origin: net progress from HERE decides wedged vs just crawling
  private vy = 0
  private grounded = true
  private boost = 100
  private boosting = false
  private driftScore = 0
  private drifting = false
  private airTime = 0
  private shake = 0

  // World
  private buildings: AABB[] = []
  // Small prop colliders (lamp poles, signal posts) that sit right beside a
  // larger solid create narrow pockets the car can wedge into but never escape
  // (car radius ~1.6). Skip a small prop when it hugs a real blocker — the car
  // cannot physically pass through a gap that tight anyway.
  private addPropCollider(box: AABB): void {
    const w = box.maxX - box.minX
    const d = box.maxZ - box.minZ
    if (w <= 1.2 && d <= 1.2) {
      for (const b of this.buildings) {
        const bw = b.maxX - b.minX
        const bd = b.maxZ - b.minZ
        if (bw < 2 || bd < 2) continue
        const gapX = Math.max(b.minX - box.maxX, box.minX - b.maxX, 0)
        const gapZ = Math.max(b.minZ - box.maxZ, box.minZ - b.maxZ, 0)
        if (Math.hypot(gapX, gapZ) < 3.3) return
      }
    }
    this.buildings.push(box)
  }
  // Order-independent sweep: some props (e.g. street lamps) register before the
  // kiosk/garage blocks they stand next to, so push-time filtering misses them.
  // After the whole city exists, drop every small prop collider that hugs a
  // real blocker — those pockets were the spawn-area wedge traps.
  private prunePropColliders(): void {
    const big = this.buildings.filter((b) => b.maxX - b.minX >= 2 && b.maxZ - b.minZ >= 2)
    this.buildings = this.buildings.filter((b) => {
      const w = b.maxX - b.minX
      const d = b.maxZ - b.minZ
      if (w > 1.2 || d > 1.2) return true
      for (const x of big) {
        const gapX = Math.max(x.minX - b.maxX, b.minX - x.maxX, 0)
        const gapZ = Math.max(x.minZ - b.maxZ, b.minZ - x.maxZ, 0)
        if (Math.hypot(gapX, gapZ) < 3.3) return false
      }
      return true
    })
  }
  private assets: GameAssets
  private drones: Drone[] = []
  private shards: Shard[] = []
  private ramps: Ramp[] = []
  private traffic: TrafficCar[] = []
  private blinkMat = new THREE.MeshBasicMaterial({ color: 0xff2233 })
  private garagePos = new THREE.Vector3()
  private markerBeacon: THREE.Mesh
  /** Harbor Rides: pooled on-road route chevrons (flat additive arrows). */
  private chevrons: THREE.Mesh[] = []
  /** Harbor Rides: live ride state for the taxi fare — violations, tip drift. */
  private ride = { violations: 0, clean: true, tipBonus: 0, speedT: 0, toastCd: 0, lastDamage: 0, wasDrifting: false, lightCd: [0, 0, 0, 0] }
  /** Camera mode: 0 = near chase, 1 = far chase, 2 = cockpit (in-car). */
  private camMode: 0 | 1 | 2 = 0
  private rain: THREE.Points | null = null
  private rainVel: Float32Array | null = null
  private waterTex: THREE.Texture | null = null
  private ambient: THREE.HemisphereLight
  private moon: THREE.DirectionalLight
  private groundMat!: THREE.MeshStandardMaterial
  private laneMat: THREE.MeshBasicMaterial | null = null
  private walkMat: THREE.MeshStandardMaterial | null = null

  // Game state
  private heat = 0
  private lastHeatInt = 0
  // New-player protection: the Patrol stays blind until the First Night guide
  // is done/skipped, plus a 60s grace after that. Speeding is judged against
  // the car's OWN top speed (85%), not a fixed km/h, so arcade speed tuning
  // can never turn "holding the gas" into a crime. The very first chase of a
  // save is capped at ★1 with no grab — one readable lesson, not a pile-up.
  private heatGraceUntil = 0
  private curTopSpeed = MAX_SPEED
  private firstChaseDone: boolean | null = null
  // Single source of truth: the Patrol is blind until First Night is
  // done/skipped AND the 60s grace has passed AND the React tour is closed.
  private get heatAllowed(): boolean {
    return this.hooks.getSave().tutorialDone && !this.onboardingActive && this.time >= this.heatGraceUntil
  }
  private bustedMeter = 0
  private busted = false
  private bustedCooldown = 0
  private mashCooldown = 0
  private droneRamCd = 0
  private cruiserRamCd = 0
  private ramToastCd = 0
  private escapeHintCd = 0
  private tutLastIdx = -1
  private tutSnapShards = -1
  private tutSnapDeliveries = 0
  private tutSnapRaces = 0
  // Seconds of real driving while the First Night guide is still unfinished.
  // At TUT_AUTO_GRAD the training wheels come off automatically — nobody
  // drives consequence-free forever just because they never read the card.
  private tutDriveTime = 0
  private mission: Mission | null = null
  private nearGarage = false
  private camDist = 10

  // Living city
  private peds: {
    x: number; z: number; axis: 'x' | 'z'; dir: 1 | -1; speed: number
    mesh: THREE.Object3D; mixer: THREE.AnimationMixer; walk: THREE.AnimationAction; baseSpeed: number
    idle: THREE.AnimationAction | null
    state: 0 | 1; ht: number; hvx: number; hvz: number; hvy: number; hspin: number
    beach: boolean
    crossing: number
    returnAxis: 'x' | 'z'
    // life behaviors: phone pauses + startled glance at fast cars
    pausing: boolean; pauseLeft: number; pauseT: number; glanceT: number
    /** horn panic: dive directly away from the car for this many seconds */
    panicT: number
    dog?: THREE.Group
    /** v2.1 zone wardrobe — shirt material refs + base colour for per-city re-tint */
    shirtMats?: THREE.MeshStandardMaterial[]
    baseShirt?: THREE.Color
  }[] = []
  private crates: { mesh: THREE.Mesh; active: boolean; respawn: number }[] = []
  // Street pickups (v2): drive-through nitro cans, field-repair kits and lucky
  // coins. Same law as the crates — the car NEVER stops; you grab these at
  // speed and they respawn somewhere else after a short cooldown.
  private pickups: { kind: 'nitro' | 'repair' | 'cash'; mesh: THREE.Group; active: boolean; respawn: number }[] = []
  private landmarks: { name: string; pos: THREE.Vector3; found: boolean; mesh: THREE.Group }[] = []
  private cruisers: { mesh: THREE.Group; barL: THREE.Mesh; barR: THREE.Mesh; pos: THREE.Vector3; vel: THREE.Vector3; wp: THREE.Vector3; heading: number; bob: number }[] = []
  private smoke: { sprite: THREE.Sprite; life: number; max: number }[] = []

  // Street cred chain multiplier (legacy cash chain — small cash toasts)
  private chainCount = 0
  private chainTimer = 0

  // =============== STREET CRED (Phase 1) ===============
  // Style chain: drift / near-miss / airtime / top-speed nitro / shake a tail.
  // Chain cred steps the multiplier ×1→×5 (100/250/500/900). 3s idle BANKS the
  // chain into XP; any damage crash BREAKS it and the unbanked part is lost.
  // Banked during a contract → +1% payout per 20 cred (cap +50%, applied at
  // payout time in step 2). Free-roam banked cred pays XP at 1:2, capped at
  // 400 XP per 10 real minutes (anti-farm: combos would pay VCoin milestones).
  private credChain = 0
  private credIdle = 0
  private credTickAcc = 0
  private credPopCd = 0
  private jumpCred = 0
  private jumpAirAcc = 0
  private jumpDamaged = false
  private credMissionBanked = 0
  private missionPeakStars = 0
  private tailTrack = new Map<object, { closeT: number; counted: boolean }>()
  private cruiserNmCd = new Map<object, number>()

  // =============== MAP CONTRACT MARKERS (Phase 1, step 3) ===============
  // 3 job beacons live on the map at all times; drive in + E to take the job —
  // no more driving back to the garage between contracts. Beacons expire after
  // 3 min; a new one spawns 60 s after one is taken or expires. One contract
  // at a time: while a mission runs, beacons stay visible but can't be taken.
  private contractMarkers: ContractMarker[] = []
  private markerSeq = 0
  private markerRespawnAt: number[] = []
  private nearMarker: ContractMarker | null = null
  private markerToastCd = 0

  constructor(canvas: HTMLCanvasElement, minimap: HTMLCanvasElement, hooks: EngineHooks, assets: GameAssets) {
    this.mmCanvas = minimap
    this.hooks = hooks
    this.assets = assets
    this.canvas = canvas
    this.damage = Math.max(0, Math.min(100, hooks.getSave().damage ?? 0))

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    } catch (err) {
      throw new Error(
        '3D graphics (WebGL) are not available in this browser panel. ' +
          'Please open the game in Chrome, Edge, or Safari instead. (' +
          (err instanceof Error ? err.message : String(err)) + ')'
      )
    }
    this.renderer = renderer
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.lowPower ? 1.25 : 1.5))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.15
    // Real-time shadows — the single biggest realism lift in the whole render
    this.renderer.shadowMap.enabled = true
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1600)
    this.camera.position.set(0, 5, 30)

    // Post-processing: neon bloom
    // `antialias: true` on the renderer does nothing once the scene is drawn
    // through EffectComposer (its off-screen targets aren't multisampled), which
    // left every building edge jagged. Give the composer a 4x MSAA target so
    // our own game never looks pixelated; applyQuality() drops it to 0 only in
    // the lowest performance tier.
    const bufSize = renderer.getDrawingBufferSize(new THREE.Vector2())
    this.composer = new EffectComposer(
      renderer,
      new THREE.WebGLRenderTarget(Math.max(1, bufSize.x), Math.max(1, bufSize.y), { type: THREE.HalfFloatType, samples: this.lowPower ? 2 : 4 }),
    )
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.42, 0.5, 0.72)
    this.composer.addPass(this.bloomPass)

    const mmCtx = minimap.getContext('2d')
    if (!mmCtx) throw new Error('no 2d context')
    this.mmCtx = mmCtx
    this.mmBase = document.createElement('canvas')
    this.mmBase.width = minimap.width
    this.mmBase.height = minimap.height

    // Lighting rig (theme-driven)
    this.ambient = new THREE.HemisphereLight(0x33415e, 0x0c0f1a, 0.85)
    this.scene.add(this.ambient)
    this.moon = new THREE.DirectionalLight(0x8fb4ff, 0.55)
    this.moon.position.set(-120, 180, 60)
    // Sun/moon casts shadows; the ortho box follows the player each frame
    this.moon.castShadow = true
    this.moon.shadow.mapSize.set(this.lowPower ? 1024 : 2048, this.lowPower ? 1024 : 2048)
    this.moon.shadow.camera.left = -110
    this.moon.shadow.camera.right = 110
    this.moon.shadow.camera.top = 110
    this.moon.shadow.camera.bottom = -110
    this.moon.shadow.camera.near = 10
    this.moon.shadow.camera.far = 520
    this.moon.shadow.bias = -0.0004
    this.moon.shadow.normalBias = 0.04
    this.scene.add(this.moon)
    this.scene.add(this.moon.target)

    // Car headlight spots (created here, targets added later)
    // Tamed: the old 60/85 intensities blew out through bloom into a white
    // wall ahead of the car — players couldn't see the road at night.
    this.headL = new THREE.SpotLight(0xcfe8ff, 18, 42, 0.46, 0.55, 1.7)
    this.headR = new THREE.SpotLight(0xcfe8ff, 18, 42, 0.46, 0.55, 1.7)
    // Phones keep only the main beam: two extra spot lights cost every pixel
    if (this.lowPower) { this.headL.visible = false; this.headR.visible = false }
    this.scene.add(this.headL, this.headL.target, this.headR, this.headR.target)
    // The one real beam: shadow-casting, lights the tarmac ahead of the car
    this.headSpot = new THREE.SpotLight(0xfff3d6, 34, 38, 0.34, 0.65, 1.5)
    // A second shadow map re-draws the whole nearby scene again — desktop only
    this.headSpot.castShadow = !this.lowPower
    this.headSpot.shadow.mapSize.set(1024, 1024)
    this.headSpot.shadow.camera.near = 2
    this.headSpot.shadow.camera.far = 60
    this.headSpot.shadow.bias = -0.002
    this.headSpot.shadow.normalBias = 0.02
    this.scene.add(this.headSpot, this.headSpot.target)

    // Boost flames (attached to car in buildCar)
    const flameGeom = new THREE.ConeGeometry(0.13, 1.0, 8)
    flameGeom.rotateX(-Math.PI / 2)
    const flameMat = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
    this.flameL = new THREE.Mesh(flameGeom, flameMat)
    this.flameR = new THREE.Mesh(flameGeom, flameMat.clone())

    // Trail ribbon
    this.trailPos = new Float32Array(30 * 3)
    this.trailGeom.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3))
    const trailMat = new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending })
    this.trailLine = new THREE.Line(this.trailGeom, trailMat)
    this.trailLine.frustumCulled = false
    this.scene.add(this.trailLine)

    // Mission beacon (glowing pillar)
    this.markerBeacon = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 1.6, 40, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.35, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
    )
    this.markerBeacon.visible = false
    this.scene.add(this.markerBeacon)

    // Harbor Rides: on-road navigation chevrons (NFS-style route arrows).
    // A small pool of flat additive arrows laid along the L-route ahead of the
    // car — visible in both chase and cockpit cameras. Basic material, no lights.
    const chevShape = new THREE.Shape()
    chevShape.moveTo(0, 1.6)
    chevShape.lineTo(1.15, -0.7)
    chevShape.lineTo(0.42, -0.25)
    chevShape.lineTo(0, -1.1)
    chevShape.lineTo(-0.42, -0.25)
    chevShape.lineTo(-1.15, -0.7)
    chevShape.closePath()
    const chevGeom = new THREE.ShapeGeometry(chevShape)
    chevGeom.rotateX(-Math.PI / 2) // lie flat on the road, tip = +Z travel dir
    for (let i = 0; i < 5; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x35f0ff, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false })
      const m = new THREE.Mesh(chevGeom, mat)
      m.visible = false
      m.renderOrder = 3
      this.scene.add(m)
      this.chevrons.push(m)
    }

    this.buildCity()
    this.buildCar()
    this.spawnShards()
    this.spawnDrones()
    this.spawnTraffic()
    this.spawnPedestrians()
    this.spawnCrates()
    this.spawnPickups()
    // Phase 1 step 3: three contract beacons live on the map from the first frame
    this.spawnContractMarker()
    this.spawnContractMarker()
    this.spawnContractMarker()
    // Phase 1 step 4: post the Night Shift goal set (rolls one for old saves)
    this.ensureShift()
    this.buildLandmarks()
    this.initWorldCircuit()
    this.prunePropColliders()
    this.spawnCruisers()
    this.initSmoke()
    this.applyLoadout()
    if (this.lowPower) this.trimShadowsForPhones()
    this.bindInput()
    this.resize()
    window.addEventListener('resize', this.resize)

    this.timer.update()
    this.loop()
  }

  // =============== CITY GENERATION ===============
  private buildCity(): void {
    const theme = getTheme(this.hooks.getSave().theme)

    // Water — animated sea: scrolling ripple texture + gentle two-tone base
    const ripple = (() => {
      const c = document.createElement('canvas')
      c.width = c.height = 256
      const g = c.getContext('2d')
      if (!g) return null
      g.fillStyle = '#e2ecf4'
      g.fillRect(0, 0, 256, 256)
      for (let i = 0; i < 90; i++) {
        const y = Math.random() * 256
        const x = Math.random() * 256
        const w = 30 + Math.random() * 90
        g.strokeStyle = `rgba(110,150,190,${0.06 + Math.random() * 0.12})`
        g.lineWidth = 1 + Math.random() * 1.6
        g.beginPath()
        g.moveTo(x, y)
        g.quadraticCurveTo(x + w / 2, y + (Math.random() - 0.5) * 8, x + w, y)
        g.stroke()
      }
      const t = new THREE.CanvasTexture(c)
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(140, 140)
      return t
    })()
    if (ripple) this.waterTex = ripple
    // Water — real animated sea: three overlapping swells displaced in the vertex
    // shader (GPU, zero CPU cost) + rolling foam bands that wash up the sand
    const waterMat = new THREE.MeshStandardMaterial({ color: theme.water, metalness: 0.2, roughness: 0.45, map: ripple ?? undefined })
    this.scene.userData.waterMat = waterMat
    const timeU = { value: 0 }
    this.scene.userData.waterTime = timeU
    waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = timeU
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          {
            // Wave phase from WORLD coords so the sea is seamless, and amplitude
            // masked to zero inside the island (x/z within ~252m) so swells can
            // never flood the streets or the beach — the ocean lives outside the sand.
            vec4 wpos = modelMatrix * vec4(position, 1.0);
            float wx = wpos.x;
            float wz = wpos.z;
            float swell1 = sin(wx * 0.055 + uTime * 1.05) * 0.6;
            float swell2 = sin(wz * 0.075 - uTime * 0.85) * 0.42;
            float swell3 = sin((wx + wz) * 0.032 + uTime * 0.55) * 0.85;
            float chop = sin(wx * 0.21 + wz * 0.17 + uTime * 1.9) * 0.2;
            float edge = max(abs(wx), abs(wz));
            float mask = smoothstep(252.0, 310.0, edge);
            transformed.z += (swell1 + swell2 + swell3 + chop) * mask;
          }`
        )
    }
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(3000, 3000, 150, 150),
      waterMat
    )
    water.rotation.x = -Math.PI / 2
    water.position.y = -0.35
    water.receiveShadow = true
    this.scene.add(water)

    // Beach — a sand ring surrounding the island edge
    const beachOuter = HALF + 46
    const beachInner = HALF + 5.5

    // Shoreline foam — a soft bright band where the sand meets the sea
    const foamShape = new THREE.Shape()
    foamShape.moveTo(-beachOuter - 2, -beachOuter - 2)
    foamShape.lineTo(beachOuter + 2, -beachOuter - 2)
    foamShape.lineTo(beachOuter + 2, beachOuter + 2)
    foamShape.lineTo(-beachOuter - 2, beachOuter + 2)
    const foamHole = new THREE.Path()
    foamHole.moveTo(-beachOuter + 5, -beachOuter + 5)
    foamHole.lineTo(-beachOuter + 5, beachOuter - 5)
    foamHole.lineTo(beachOuter - 5, beachOuter - 5)
    foamHole.lineTo(beachOuter - 5, -beachOuter + 5)
    foamShape.holes.push(foamHole)
    const foam = new THREE.Mesh(
      new THREE.ShapeGeometry(foamShape),
      new THREE.MeshBasicMaterial({ color: 0xbfe6ea, transparent: true, opacity: 0.18, depthWrite: false })
    )
    foam.rotation.x = -Math.PI / 2
    foam.position.y = -0.22
    this.scene.add(foam)
    // Rolling swell lines: three foam rings that crawl toward the sand and fade,
    // so the shoreline reads as breathing surf rather than a static stripe
    const foamBands: THREE.Mesh[] = []
    for (let b = 0; b < 5; b++) {
      const outerR = beachOuter + 2 - b * 2.4
      const innerR = outerR - 3.4
      const bandShape = new THREE.Shape()
      bandShape.moveTo(-outerR, -outerR)
      bandShape.lineTo(outerR, -outerR)
      bandShape.lineTo(outerR, outerR)
      bandShape.lineTo(-outerR, outerR)
      const bandHole = new THREE.Path()
      bandHole.moveTo(-innerR, -innerR)
      bandHole.lineTo(-innerR, innerR)
      bandHole.lineTo(innerR, innerR)
      bandHole.lineTo(innerR, -innerR)
      bandShape.holes.push(bandHole)
      const band = new THREE.Mesh(
        new THREE.ShapeGeometry(bandShape),
        new THREE.MeshBasicMaterial({ color: 0xeaf7f9, transparent: true, opacity: 0, depthWrite: false })
      )
      band.rotation.x = -Math.PI / 2
      band.position.y = -0.18
      band.userData.phase = b / 5
      this.scene.add(band)
      foamBands.push(band)
    }
    this.scene.userData.foamBands = foamBands
    const sandShape = new THREE.Shape()
    sandShape.moveTo(-beachOuter, -beachOuter)
    sandShape.lineTo(beachOuter, -beachOuter)
    sandShape.lineTo(beachOuter, beachOuter)
    sandShape.lineTo(-beachOuter, beachOuter)
    sandShape.closePath()
    const hole = new THREE.Path()
    hole.moveTo(-beachInner, -beachInner)
    hole.lineTo(beachInner, -beachInner)
    hole.lineTo(beachInner, beachInner)
    hole.lineTo(-beachInner, beachInner)
    hole.closePath()
    sandShape.holes.push(hole)
    const sandGeom = new THREE.ShapeGeometry(sandShape)
    sandGeom.rotateX(-Math.PI / 2)
    const sandGrain = (() => {
      const c = document.createElement('canvas')
      c.width = c.height = 256
      const g = c.getContext('2d')
      if (!g) return null
      g.fillStyle = '#c9b489'
      g.fillRect(0, 0, 256, 256)
      for (let i = 0; i < 7000; i++) {
        const v = 160 + Math.floor(Math.random() * 75)
        g.fillStyle = `rgb(${v},${Math.floor(v * 0.9)},${Math.floor(v * 0.68)})`
        g.fillRect(Math.random() * 256, Math.random() * 256, 1.4, 1.4)
      }
      const t = new THREE.CanvasTexture(c)
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      // ShapeGeometry UVs are raw world coords (span ~±253), so a small repeat = one tile per ~6 units
      t.repeat.set(0.17, 0.17)
      t.anisotropy = 4
      return t
    })()
    const sand = new THREE.Mesh(
      sandGeom,
      new THREE.MeshStandardMaterial({
        color: 0xa8987a,
        map: sandGrain ?? undefined,
        roughness: 1.0,
        metalness: 0,
        emissive: 0x100c05,
      })
    )
    sand.position.y = 0.05
    this.scene.add(sand)

    // Beach props: parasols + towels grouped into busy clusters along the sand,
    // with a clear lane around the shore spawn point (8, 226)
    const beachRand = seededRand(20240)
    const towelPalette = [0xff6b9d, 0x4ecdc4, 0xffe66d, 0x95e1d3, 0xf38181, 0xa8e6cf]
    const towelGeom = new THREE.BoxGeometry(1.1, 0.05, 2.0)
    const poleGeom = new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6)
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.8 })
    const SPAWN_X = 8
    const SPAWN_Z = 226
    for (let side = 0; side < 4; side++) {
      for (let cluster = 0; cluster < 7; cluster++) {
        const along = (beachRand() * 2 - 1) * (HALF + 2)
        const out = beachInner + 4 + beachRand() * 26
        let cx = 0
        let cz = 0
        if (side === 0) { cx = along; cz = -out } else if (side === 1) { cx = along; cz = out }
        else if (side === 2) { cx = -out; cz = along } else { cx = out; cz = along }
        if ((cx - SPAWN_X) ** 2 + (cz - SPAWN_Z) ** 2 < 15 * 15) continue
        const nProps = 3 + Math.floor(beachRand() * 2)
        for (let k = 0; k < nProps; k++) {
          const px = cx + (beachRand() - 0.5) * 10
          const pz = cz + (beachRand() - 0.5) * 10
          // Parasol (real Kenney model) every other spot
          if (k % 2 === 0) {
            const modelKey = beachRand() > 0.5 ? 'detail-parasol-a' : 'detail-parasol-b'
            const cm = this.assets.city[modelKey]
            if (cm) {
              const umb = new THREE.Mesh(cm.geometry, this.assets.cityMaterial)
              const s = 1.6 / Math.max(cm.size.y, 0.01)
              umb.scale.setScalar(s)
              umb.position.set(px, -cm.minY * s + 0.02, pz)
              umb.rotation.y = beachRand() * Math.PI * 2
              this.scene.add(umb)
              const pole = new THREE.Mesh(poleGeom, poleMat)
              pole.position.set(px, 1.1, pz)
              this.scene.add(pole)
            } else {
              // parasol model unavailable — towel only
            }
          }
          // Towel
          const towel = new THREE.Mesh(
            towelGeom,
            new THREE.MeshStandardMaterial({ color: towelPalette[Math.floor(beachRand() * towelPalette.length)], roughness: 0.95 })
          )
          towel.position.set(px + (beachRand() - 0.5) * 2.5, 0.09, pz + (beachRand() - 0.5) * 2.5)
          towel.rotation.y = beachRand() * Math.PI
          this.scene.add(towel)
        }
      }
    }

    // Ground slab — procedural asphalt grain, tinted by theme (reads as real tarmac, not a flat color)
    const asphalt = (() => {
      const c = document.createElement('canvas')
      c.width = c.height = 256
      const g = c.getContext('2d')
      if (!g) return null
      g.fillStyle = '#9aa0a8'
      g.fillRect(0, 0, 256, 256)
      for (let i = 0; i < 5200; i++) {
        const v = 118 + Math.floor(Math.random() * 62)
        g.fillStyle = `rgb(${v},${v},${v + 5})`
        g.fillRect(Math.random() * 256, Math.random() * 256, 1.6, 1.6)
      }
      for (let i = 0; i < 26; i++) {
        g.strokeStyle = 'rgba(40,44,52,0.25)'
        g.lineWidth = 0.8
        g.beginPath()
        const sx = Math.random() * 256
        const sy = Math.random() * 256
        g.moveTo(sx, sy)
        g.lineTo(sx + (Math.random() - 0.5) * 60, sy + (Math.random() - 0.5) * 60)
        g.stroke()
      }
      const t = new THREE.CanvasTexture(c)
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(52, 52)
      t.anisotropy = 4
      return t
    })()
    this.groundMat = new THREE.MeshStandardMaterial({ color: theme.ground, map: asphalt ?? undefined, roughness: 0.55, metalness: 0.35 })
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(SIZE + 8, 0.5, SIZE + 8),
      this.groundMat
    )
    ground.receiveShadow = true
    ground.position.y = -0.26
    this.scene.add(ground)

    // Lane markings
    const laneMat = new THREE.MeshBasicMaterial({ color: 0x3f4b66 })
    this.laneMat = laneMat
    const laneGeomH = new THREE.BoxGeometry(SIZE, 0.02, 0.28)
    const laneGeomV = new THREE.BoxGeometry(0.28, 0.02, SIZE)
    for (let k = 0; k <= N; k++) {
      const c = -HALF + ROAD / 2 + k * CELL
      const laneH = new THREE.Mesh(laneGeomH, laneMat)
      laneH.position.set(0, 0.012, c)
      this.scene.add(laneH)
      const laneV = new THREE.Mesh(laneGeomV, laneMat)
      laneV.position.set(c, 0.012, 0)
      this.scene.add(laneV)
    }

    // Sidewalk frames around every block
    const walkGeom = new THREE.BoxGeometry(1, 1, 1)
    const walkMat = new THREE.MeshStandardMaterial({ color: 0x1c2334, roughness: 0.9 })
    this.walkMat = walkMat
    const walks = new THREE.InstancedMesh(walkGeom, walkMat, N * N * 4)
    const m4 = new THREE.Matrix4()
    let wi = 0
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const bx = blockOrigin(i)
        const bz = blockOrigin(j)
        const L = BLOCK + 3
        const strips: [number, number, number, number][] = [
          [bx + BLOCK / 2, bz - 1.3, L, 2.6],
          [bx + BLOCK / 2, bz + BLOCK + 1.3, L, 2.6],
          [bx - 1.3, bz + BLOCK / 2, 2.6, L],
          [bx + BLOCK + 1.3, bz + BLOCK / 2, 2.6, L],
        ]
        for (const [x, z, sx, sz] of strips) {
          m4.makeScale(sx, 0.16, sz)
          m4.setPosition(x, 0.06, z)
          walks.setMatrixAt(wi++, m4)
        }
      }
    }
    walks.instanceMatrix.needsUpdate = true
    this.scene.add(walks)

    // Harbor quay edge glow
    const quayMat = new THREE.MeshBasicMaterial({ color: 0x155e75 })
    const quayN = new THREE.Mesh(new THREE.BoxGeometry(SIZE + 8, 0.35, 0.6), quayMat)
    quayN.position.set(0, 0.05, -HALF - 4 + 0.3)
    const quayS = quayN.clone()
    quayS.position.z = HALF + 4 - 0.3
    const quayW = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.35, SIZE + 8), quayMat)
    quayW.position.set(-HALF - 4 + 0.3, 0.05, 0)
    const quayE = quayW.clone()
    quayE.position.x = HALF + 4 - 0.3
    this.scene.add(quayN, quayS, quayW, quayE)

    // Buildings — district-aware, real Kenney CC0 architecture (instanced GLB models)
    const rand = seededRand(1337)
    const pickModel = (kind: 'skyscraper' | 'midrise' | 'lowrise', r: () => number): string => {
      const pool = CITY_BY_KIND[kind]
      return pool[Math.floor(r() * pool.length) % pool.length]
    }
    const placements: Placement[] = []
    const marketPlacements: Placement[] = []
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if (i === GARAGE_I && j === GARAGE_J) continue // garage plaza
        const dist = districtOf(i, j)
        const bx = blockOrigin(i)
        const bz = blockOrigin(j)
        for (let li = 0; li < 2; li++) {
          for (let lj = 0; lj < 2; lj++) {
            // Reserved landmark plazas — built by buildCulturalQuarters()
            if (i === 2 && j === 2 && li === 0 && lj === 0) continue // London clock tower
            if (i === 7 && j === 3 && li === 1 && lj === 0) continue // Beijing pagoda
            if (i === 4 && j === 7) continue // Construction stunt yard (whole block)
            if (i === 3 && j === 7 && li === 0 && lj === 0) continue // dirt-pile corner
            if (rand() < (dist === 'construction' ? 0.42 : 0.16)) continue // empty lot
            const lotW = BLOCK / 2
            const w = lotW - 3 - rand() * 3
            const d = lotW - 3 - rand() * 3
            const tall = dist === 'downtown'
            const flat = dist === 'construction'
            const terraced = dist === 'london'
            const podium = !flat && !terraced && rand() < (tall ? 0.55 : 0.3)
            const hBase = flat ? 7 + rand() * 9 : tall ? 26 + rand() * 34 : terraced ? 8 + rand() * 10 : 12 + rand() * 16
            const h = podium ? Math.min(hBase, 15) : hBase
            const x = bx + li * lotW + lotW / 2 + (rand() - 0.5) * 2
            const z = bz + lj * lotW + lotW / 2 + (rand() - 0.5) * 2
            const signs = dist === 'beijing' ? 4 : dist === 'downtown' ? 2 : 1
            const baseKind: 'skyscraper' | 'midrise' | 'lowrise' = flat ? 'lowrise' : terraced ? (rand() < 0.65 ? 'lowrise' : 'midrise') : tall && !podium ? 'skyscraper' : 'midrise'
            const place = (p: Placement) => {
              placements.push(p)
              if (dist === 'beijing') marketPlacements.push(p)
              this.buildings.push({ minX: p.x - p.w / 2, maxX: p.x + p.w / 2, minZ: p.z - p.d / 2, maxZ: p.z + p.d / 2 })
            }
            place({ x, z, w, h, d, tint: 0.75 + rand() * 0.5, signs, model: pickModel(baseKind, rand), rot: Math.floor(rand() * 4), dist })
            // Tower on podium — skyline variety (never on London terraces)
            if (podium && rand() < (tall ? 0.85 : 0.4)) {
              const th = h + 12 + rand() * (tall ? 30 : 12)
              place({
                x: x + (rand() - 0.5) * 2, z: z + (rand() - 0.5) * 2,
                w: w * 0.55, h: th, d: d * 0.55, tint: 0.9 + rand() * 0.4,
                signs: dist === 'beijing' ? 2 : 1,
                model: pickModel(tall ? 'skyscraper' : 'midrise', rand), rot: Math.floor(rand() * 4),
                dist,
              })
            }
          }
        }
      }
    }
    // v2.1 — one architecture pack per city, all sharing these placements
    for (const z of WORLD_ZONES) this.buildZoneCityVisuals(z, placements, marketPlacements)

    // Street lights — full pole + curved arm + head assemblies (instanced),
    // with warm light pools on the tarmac and a soft glow at each head.
    const lampSpots: { x: number; z: number; rot: number }[] = []
    for (let k = 0; k <= N; k++) {
      const c = -HALF + ROAD / 2 + k * CELL
      const off = ROAD / 2 + 0.7 // sidewalk edge
      for (let a = -HALF + 14; a < HALF - 10; a += 22) {
        // stagger the two sides so neighbouring pools don't overlap
        lampSpots.push({ x: c - off, z: a, rot: Math.PI / 2 })            // arm reaches +x
        lampSpots.push({ x: c + off, z: a + 11 <= HALF - 10 ? a + 11 : a, rot: -Math.PI / 2 }) // arm reaches -x
        lampSpots.push({ x: a, z: c - off, rot: 0 })                      // arm reaches +z
        lampSpots.push({ x: a + 11 <= HALF - 10 ? a + 11 : a, z: c + off, rot: Math.PI })      // arm reaches -z
      }
    }
    // Merge pole+arm+housing into one geometry so each lamp is a single instance
    const lampPoleGeom = new THREE.CylinderGeometry(0.09, 0.15, 6.2, 6)
    lampPoleGeom.translate(0, 3.1, 0)
    const armGeom = new THREE.BoxGeometry(0.09, 0.09, 1.7)
    armGeom.translate(0, 6.05, 0.75)
    const housingGeom = new THREE.BoxGeometry(0.24, 0.14, 0.56)
    housingGeom.translate(0, 5.98, 1.55)
    const poleMerged = mergeGeometries([lampPoleGeom, armGeom, housingGeom])!
    const lampPoleMat = new THREE.MeshStandardMaterial({ color: 0x2b3138, roughness: 0.6, metalness: 0.55 })
    const poles = new THREE.InstancedMesh(poleMerged, lampPoleMat, lampSpots.length)
    const lensGeom = new THREE.SphereGeometry(0.17, 8, 8)
    lensGeom.translate(0, 5.9, 1.55)
    const lensMat = new THREE.MeshBasicMaterial({ color: 0xffe2b0 })
    const lenses = new THREE.InstancedMesh(lensGeom, lensMat, lampSpots.length)
    const poolGeom = new THREE.CircleGeometry(4.6, 20)
    poolGeom.rotateX(-Math.PI / 2)
    const poolMat = new THREE.MeshBasicMaterial({
      color: 0xffc98a, transparent: true, opacity: 0.15, map: makeGlowTexture(),
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
    const pools = new THREE.InstancedMesh(poolGeom, poolMat, lampSpots.length)
    const glowPos = new Float32Array(lampSpots.length * 3)
    lampSpots.forEach((s, i) => {
      m4.makeRotationY(s.rot)
      m4.setPosition(s.x, 0, s.z)
      poles.setMatrixAt(i, m4)
      lenses.setMatrixAt(i, m4)
      m4.makeScale(1, 1, 1)
      m4.setPosition(s.x, 0.05, s.z)
      pools.setMatrixAt(i, m4)
      glowPos[i * 3] = s.x + Math.sin(s.rot) * 1.55
      glowPos[i * 3 + 1] = 5.9
      glowPos[i * 3 + 2] = s.z + Math.cos(s.rot) * 1.55
      this.addPropCollider({ minX: s.x - 0.25, maxX: s.x + 0.25, minZ: s.z - 0.25, maxZ: s.z + 0.25 })
    })
    poles.instanceMatrix.needsUpdate = true
    lenses.instanceMatrix.needsUpdate = true
    pools.instanceMatrix.needsUpdate = true
    poles.castShadow = true
    this.scene.add(poles, lenses, pools)
    const glowGeom = new THREE.BufferGeometry()
    glowGeom.setAttribute('position', new THREE.BufferAttribute(glowPos, 3))
    const glowMat = new THREE.PointsMaterial({
      color: 0xffd9a0, size: 2.4, map: makeGlowTexture(), transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    })
    const glows = new THREE.Points(glowGeom, glowMat)
    glows.frustumCulled = false
    this.scene.add(glows)
    // Stash for theme switching: lamps glow at night, go dark by day
    this.scene.userData.lampMats = { lens: lensMat, pool: poolMat, glow: glowMat }

    this.genHarborProps(rand)
    this.genStreetFoliage()
    this.genBillboards()
    this.genSkyline()
    this.genSky()
    this.genPuddles()
    this.genRoadFurniture(rand)
    this.genStreetFood(rand)
    this.genBeachLife(rand)
    this.genRoadMarkings()
    this.genTrafficLights()
    this.genIdleCharacters(rand)
    this.genHarborLife(rand)
    this.genMoonTrack()
    this.genClouds(rand)

    // Garage plaza (center block)
    const gx = blockOrigin(GARAGE_I) + BLOCK / 2
    const gz = blockOrigin(GARAGE_J) + BLOCK / 2
    this.garagePos.set(gx, 0, gz)
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(7, 7, 0.15, 32),
      new THREE.MeshStandardMaterial({ color: 0x164e63, emissive: 0x22d3ee, emissiveIntensity: 0.5, roughness: 0.4 })
    )
    pad.position.set(gx, 0.08, gz)
    this.scene.add(pad)
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.1, 60, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.16, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
    )
    beam.position.set(gx, 30, gz)
    this.scene.add(beam)
    const kioskTex = (() => {
      const c = document.createElement('canvas')
      c.width = c.height = 256
      const g = c.getContext('2d')
      if (!g) return null
      // shopfront: dark panel, striped awning, neon sign, lit window
      g.fillStyle = '#111a2b'
      g.fillRect(0, 0, 256, 256)
      g.fillStyle = '#1c2940'
      g.fillRect(0, 0, 256, 26)
      for (let i = 0; i < 8; i++) {
        g.fillStyle = i % 2 ? '#ff2d95' : '#f8e1f4'
        g.fillRect(i * 32, 26, 32, 22)
      }
      g.shadowColor = '#ff2d95'; g.shadowBlur = 18
      g.fillStyle = '#ffd7ee'
      g.font = 'bold 44px monospace'
      g.textAlign = 'center'
      g.fillText('MART 24', 128, 116)
      g.shadowBlur = 0
      g.fillStyle = '#fbbf24'
      g.globalAlpha = 0.85
      g.fillRect(34, 150, 188, 66)
      g.globalAlpha = 1
      g.fillStyle = '#3b2f14'
      for (let i = 0; i < 5; i++) g.fillRect(44 + i * 38, 158, 8, 50)
      const t = new THREE.CanvasTexture(c)
      t.anisotropy = 4
      return t
    })()
    const kioskPanel = new THREE.MeshStandardMaterial({ color: 0x1e293b, emissive: 0xff2d95, emissiveIntensity: 0.12, roughness: 0.5 })
    const kioskFace = new THREE.MeshStandardMaterial({ color: 0xffffff, map: kioskTex ?? undefined, emissive: 0xffffff, emissiveMap: kioskTex ?? undefined, emissiveIntensity: 0.28, roughness: 0.5 })
    const shopKiosk = new THREE.Mesh(
      new THREE.BoxGeometry(6, 4, 6),
      [kioskFace, kioskPanel, kioskPanel, kioskPanel, kioskFace, kioskPanel]
    )
    shopKiosk.position.set(gx - 10, 2, gz - 10)
    shopKiosk.castShadow = true
    this.scene.add(shopKiosk)
    this.buildings.push({ minX: gx - 13, maxX: gx - 7, minZ: gz - 13, maxZ: gz - 7 })

    // Spawn set-piece — painted pit pad, entrance gantry with neon sign, props
    const padDecal = (() => {
      const c = document.createElement('canvas')
      c.width = c.height = 512
      const g = c.getContext('2d')
      if (!g) return null
      g.fillStyle = '#0b2530'
      g.fillRect(0, 0, 512, 512)
      g.strokeStyle = '#22d3ee'
      g.lineWidth = 10
      g.beginPath(); g.arc(256, 256, 210, 0, Math.PI * 2); g.stroke()
      g.strokeStyle = '#facc15'
      g.setLineDash([26, 18])
      g.beginPath(); g.arc(256, 256, 160, 0, Math.PI * 2); g.stroke()
      g.setLineDash([])
      g.fillStyle = '#e2f4ff'
      g.font = 'bold 64px monospace'
      g.textAlign = 'center'
      g.fillText('GARAGE 07', 256, 246)
      g.font = 'bold 30px monospace'
      g.fillStyle = '#67e8f9'
      g.fillText('PIT CREW — SERVICE BAY', 256, 300)
      const t = new THREE.CanvasTexture(c)
      t.anisotropy = 4
      return t
    })()
    const padTop = new THREE.Mesh(
      new THREE.CircleGeometry(6.9, 40),
      new THREE.MeshStandardMaterial({ map: padDecal ?? undefined, color: padDecal ? 0xffffff : 0x164e63, emissive: 0x0e7490, emissiveIntensity: 0.25, emissiveMap: padDecal ?? undefined, roughness: 0.5 })
    )
    padTop.rotation.x = -Math.PI / 2
    padTop.position.set(gx, 0.17, gz)
    padTop.receiveShadow = true
    this.scene.add(padTop)

    // Gantry over the plaza entrance with a hanging neon sign
    const gantryMat = new THREE.MeshStandardMaterial({ color: 0x37424f, roughness: 0.5, metalness: 0.6 })
    const legGeom = new THREE.BoxGeometry(0.5, 7.4, 0.5)
    const legA = new THREE.Mesh(legGeom, gantryMat); legA.position.set(gx - 8, 3.7, gz + 12)
    const legB = new THREE.Mesh(legGeom, gantryMat); legB.position.set(gx + 8, 3.7, gz + 12)
    const cross = new THREE.Mesh(new THREE.BoxGeometry(17, 0.7, 0.7), gantryMat)
    cross.position.set(gx, 7.2, gz + 12)
    legA.castShadow = legB.castShadow = cross.castShadow = true
    this.scene.add(legA, legB, cross)
    this.buildings.push({ minX: gx - 8.4, maxX: gx - 7.6, minZ: gz + 11.6, maxZ: gz + 12.4 })
    this.buildings.push({ minX: gx + 7.6, maxX: gx + 8.4, minZ: gz + 11.6, maxZ: gz + 12.4 })
    const sign = (() => {
      const c = document.createElement('canvas')
      c.width = 2048; c.height = 512
      const g = c.getContext('2d')
      if (!g) return null
      g.scale(4, 4)
      g.fillStyle = '#0a0f1c'
      g.fillRect(0, 0, 512, 128)
      g.font = 'bold 72px monospace'
      g.textAlign = 'center'
      g.shadowColor = '#22d3ee'; g.shadowBlur = 14
      g.fillStyle = '#67e8f9'
      g.fillText('NEON HARBOR', 256, 88)
      const t = new THREE.CanvasTexture(c)
      t.anisotropy = 8
      return t
    })()
    if (sign) {
      const signMesh = new THREE.Mesh(
        new THREE.BoxGeometry(11, 2.4, 0.3),
        new THREE.MeshStandardMaterial({ color: 0x111827, emissive: 0xbfe6f5, emissiveMap: sign, emissiveIntensity: 0.55, roughness: 0.4 })
      )
      signMesh.position.set(gx, 5.6, gz + 12)
      this.scene.add(signMesh)
    }

    // Pit props: tire stacks + cone row
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.9 })
    const tireGeom = new THREE.TorusGeometry(0.42, 0.17, 8, 14)
    tireGeom.rotateX(Math.PI / 2)
    const tireSpots = [[gx - 9, gz - 6], [gx - 9.9, gz - 6.4], [gx + 9.2, gz - 5.4]]
    tireSpots.forEach(([tx, tz], i) => {
      for (let s = 0; s < 3; s++) {
        const tire = new THREE.Mesh(tireGeom, tireMat)
        tire.position.set(tx, 0.19 + s * 0.34, tz)
        tire.rotation.y = i + s
        tire.castShadow = true
        this.scene.add(tire)
      }
    })
    const coneGeom = new THREE.ConeGeometry(0.22, 0.6, 8)
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xf97316, emissive: 0x7c2d12, emissiveIntensity: 0.4, roughness: 0.6 })
    for (let i = 0; i < 5; i++) {
      const cone = new THREE.Mesh(coneGeom, coneMat)
      cone.position.set(gx - 6 + i * 3, 0.3, gz + 15.5)
      cone.castShadow = true
      this.scene.add(cone)
    }
    // Parked crew car beside the kiosk
    const crewCar = cloneCar(this.assets, 'sedan-sports', 0xd8dee9)
    const crewBox = new THREE.Box3().setFromObject(crewCar)
    const crewLen = crewBox.max.z - crewBox.min.z
    const crewScale = crewLen > 0.01 ? 4.4 / crewLen : 1
    crewCar.scale.setScalar(crewScale)
    crewCar.position.set(gx + 10, -crewBox.min.y * crewScale, gz - 9)
    crewCar.rotation.y = Math.PI / 3
    crewCar.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) m.castShadow = true
    })
    this.scene.add(crewCar)
    this.buildings.push({ minX: gx + 8.4, maxX: gx + 11.6, minZ: gz - 10.6, maxZ: gz - 7.4 })

    // Stunt ramps: parked in a dedicated lane (offset from the centre line) so
    // they never block the through-traffic lane, with a low approach wedge.
    const rampRand = seededRand(4242)
    const rampMat = new THREE.MeshStandardMaterial({ color: 0x334155, emissive: 0xf97316, emissiveIntensity: 0.35, roughness: 0.6 })
    const wedgeMat = new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.7 })
    for (let k = 0; k < 5; k++) {
      const onHorizontal = rampRand() > 0.5
      const lane = 1 + Math.floor(rampRand() * (N - 1))
      const along = (rampRand() * 2 - 1) * (HALF - 60)
      const c = -HALF + ROAD / 2 + lane * CELL
      const lateral = (rampRand() > 0.5 ? 1 : -1) * 3.4
      const x = onHorizontal ? along : c + lateral
      const z = onHorizontal ? c + lateral : along
      const angle = onHorizontal ? 0 : Math.PI / 2
      const ramp = new THREE.Mesh(new THREE.BoxGeometry(7, 0.6, 9), rampMat)
      ramp.position.set(x, 0.9, z)
      ramp.rotation.x = -0.28
      ramp.rotation.y = angle
      this.scene.add(ramp)
      const wedge = new THREE.Mesh(new THREE.BoxGeometry(7, 0.4, 5), wedgeMat)
      wedge.position.set(x + Math.sin(angle) * -5.2, 0.25, z + Math.cos(angle) * -5.2)
      wedge.rotation.x = -0.12
      wedge.rotation.y = angle
      this.scene.add(wedge)
      this.ramps.push({ x, z, angle })
    }

    // ---- SOUTH BRIDGE & LIGHTHOUSE ISLAND --------------------------------
    // A neon-railed bridge over the open sea to a palm island with a working
    // lighthouse — the scenic drive of the map. Drivable bounds live in
    // collide(); the deck connects the beach ring to the island sand.
    {
      const bridgeStart = HALF + 44 // just past the sand ring
      const islandC = HALF + 170
      const islandR = 48
      const deckLen = islandC - islandR + 8 - bridgeStart
      const deckZ = bridgeStart + deckLen / 2
      const deck = new THREE.Mesh(
        new THREE.BoxGeometry(18, 0.6, deckLen),
        new THREE.MeshStandardMaterial({ color: 0x2b3242, roughness: 0.55, metalness: 0.35 })
      )
      deck.position.set(0, 0.02, deckZ)
      deck.receiveShadow = true
      this.scene.add(deck)
      // Neon edge rails — they glow the way across at night
      const railMat = new THREE.MeshStandardMaterial({ color: 0x1c2230, emissive: 0x22d3ee, emissiveIntensity: 0.9, roughness: 0.4 })
      for (const sx of [-8.6, 8.6]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.0, deckLen), railMat)
        rail.position.set(sx, 0.75, deckZ)
        this.scene.add(rail)
      }
      // Support pillars + warm lamp dots alternating sides
      const pillarMat = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.8 })
      const lampMat = new THREE.MeshStandardMaterial({ color: 0x111827, emissive: 0xffd27d, emissiveIntensity: 1.8 })
      let lampSide = 1
      for (let d = bridgeStart + 8; d < bridgeStart + deckLen - 4; d += 16) {
        for (const sx of [-6, 6]) {
          const p = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.1, 9, 8), pillarMat)
          p.position.set(sx, -4, d)
          this.scene.add(p)
        }
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 8), lampMat)
        lamp.position.set(8.6 * lampSide, 1.7, d)
        this.scene.add(lamp)
        lampSide *= -1
      }
      // Mega ramp mid-bridge — hit it on nitro and you fly toward the island
      const mega = new THREE.Mesh(new THREE.BoxGeometry(9, 0.7, 10), rampMat)
      mega.position.set(0, 0.95, bridgeStart + deckLen * 0.45)
      mega.rotation.x = -0.3
      this.scene.add(mega)
      this.ramps.push({ x: 0, z: bridgeStart + deckLen * 0.45, angle: Math.PI / 2 })
      // Island: sand disc + grass heart
      const islSand = new THREE.Mesh(
        new THREE.CylinderGeometry(islandR, islandR + 3, 0.9, 40),
        new THREE.MeshStandardMaterial({ color: 0xdfd29a, roughness: 0.95 })
      )
      islSand.position.set(0, 0.12, islandC)
      islSand.receiveShadow = true
      this.scene.add(islSand)
      const islGrass = new THREE.Mesh(
        new THREE.CylinderGeometry(29, 29, 0.4, 32),
        new THREE.MeshStandardMaterial({ color: 0x3f7a52, roughness: 0.9 })
      )
      islGrass.position.set(0, 0.62, islandC)
      this.scene.add(islGrass)
      // Palms
      const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.9 })
      const frondMat = new THREE.MeshStandardMaterial({ color: 0x2e7d4f, roughness: 0.85, side: THREE.DoubleSide })
      const palmRand = seededRand(777)
      for (let i = 0; i < 10; i++) {
        const a = palmRand() * Math.PI * 2
        const r = 20 + palmRand() * 20
        const px = Math.cos(a) * r
        const pz = islandC + Math.sin(a) * r * 0.85
        if (Math.abs(px) < 6 && pz < islandC - 20) continue // keep the bridge mouth clear
        const lean = (palmRand() - 0.5) * 0.3
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.36, 5.6, 6), trunkMat)
        trunk.position.set(px, 3.1, pz)
        trunk.rotation.z = lean
        trunk.castShadow = true
        this.scene.add(trunk)
        for (let f = 0; f < 6; f++) {
          const frond = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.9), frondMat)
          frond.position.set(px - Math.sin(lean) * 2.6, 6.1, pz)
          frond.rotation.y = (f / 6) * Math.PI * 2
          frond.rotation.x = -0.55
          frond.translateY(1.1)
          this.scene.add(frond)
        }
        this.buildings.push({ minX: px - 0.45, maxX: px + 0.45, minZ: pz - 0.45, maxZ: pz + 0.45 })
      }
      // Lighthouse: striped tower, lamp room, rotating beam
      const lhX = 16
      const lhZ = islandC + 14
      const stripeW = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.6 })
      const stripeR = new THREE.MeshStandardMaterial({ color: 0xc9303c, roughness: 0.6 })
      for (let sgm = 0; sgm < 4; sgm++) {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(2.0 - sgm * 0.22, 2.2 - sgm * 0.22, 3.4, 12), sgm % 2 === 0 ? stripeW : stripeR)
        t.position.set(lhX, 2.2 + sgm * 3.4, lhZ)
        t.castShadow = true
        this.scene.add(t)
      }
      const lampRoom = new THREE.Mesh(
        new THREE.CylinderGeometry(1.3, 1.3, 1.8, 10),
        new THREE.MeshStandardMaterial({ color: 0x1f2937, emissive: 0xfff2b0, emissiveIntensity: 2.4 })
      )
      lampRoom.position.set(lhX, 15.6, lhZ)
      this.scene.add(lampRoom)
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.7, 1.6, 10), stripeR)
      roof.position.set(lhX, 17.2, lhZ)
      this.scene.add(roof)
      const beamGeom = new THREE.ConeGeometry(7, 46, 16, 1, true)
      beamGeom.rotateX(-Math.PI / 2) // point the cone along +z
      beamGeom.translate(0, 0, 23)
      this.lighthouseBeam = new THREE.Mesh(beamGeom, new THREE.MeshBasicMaterial({
        color: 0xfff2b0, transparent: true, opacity: 0.12, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }))
      this.lighthouseBeam.position.set(lhX, 15.6, lhZ)
      this.scene.add(this.lighthouseBeam)
      const lhGlow = new THREE.PointLight(0xfff2b0, 60, 60, 1.6)
      lhGlow.position.set(lhX, 15.6, lhZ)
      if (!this.lowPower) this.scene.add(lhGlow)
      this.buildings.push({ minX: lhX - 2.6, maxX: lhX + 2.6, minZ: lhZ - 2.6, maxZ: lhZ + 2.6 })
    }

    this.buildCulturalQuarters()

    // Spawn just past the gantry so the neon arch frames the player's starting view instead of filling it
    this.pos.set(gx, 0, gz + 19)
    this.drawMinimapBase()
  }

  /** Cultural quarters: London clock tower + phone boxes, Beijing pagoda +
      lantern streets, and the construction stunt yard. Reserved plazas are
      skipped by the building generator above. */
  private buildCulturalQuarters(): void {
    const lot = (i: number, j: number, li: number, lj: number) => ({
      x: blockOrigin(i) + li * (BLOCK / 2) + BLOCK / 4,
      z: blockOrigin(j) + lj * (BLOCK / 2) + BLOCK / 4,
    })

    // ---- LONDON: the old clock tower (Big Ben silhouette, glowing face) ----
    {
      const { x, z } = lot(2, 2, 0, 0)
      const brick = new THREE.MeshStandardMaterial({ color: 0x8a5a48, roughness: 0.85 })
      const tower = new THREE.Mesh(new THREE.BoxGeometry(7, 30, 7), brick)
      tower.position.set(x, 15, z)
      tower.castShadow = true
      this.scene.add(tower)
      // Clock faces on all four sides — warm glowing discs with dark hands
      const faceCanvas = document.createElement('canvas')
      faceCanvas.width = faceCanvas.height = 128
      const fc = faceCanvas.getContext('2d')!
      fc.fillStyle = '#f6efdc'
      fc.beginPath(); fc.arc(64, 64, 60, 0, Math.PI * 2); fc.fill()
      fc.strokeStyle = '#2c2418'; fc.lineWidth = 5; fc.stroke()
      for (let t = 0; t < 12; t++) {
        const a = (t / 12) * Math.PI * 2
        fc.beginPath()
        fc.moveTo(64 + Math.cos(a) * 50, 64 + Math.sin(a) * 50)
        fc.lineTo(64 + Math.cos(a) * 56, 64 + Math.sin(a) * 56)
        fc.stroke()
      }
      fc.lineWidth = 6
      fc.beginPath(); fc.moveTo(64, 64); fc.lineTo(64 + 18, 64 - 26); fc.stroke() // hour hand
      fc.lineWidth = 4
      fc.beginPath(); fc.moveTo(64, 64); fc.lineTo(64 - 8, 64 - 44); fc.stroke()  // minute hand
      const faceTex = new THREE.CanvasTexture(faceCanvas)
      const faceMat = new THREE.MeshBasicMaterial({ map: faceTex })
      for (let f = 0; f < 4; f++) {
        const face = new THREE.Mesh(new THREE.CircleGeometry(2.6, 24), faceMat)
        const a = f * Math.PI * 0.5
        face.position.set(x + Math.sin(a) * 3.56, 25.5, z + Math.cos(a) * 3.56)
        face.rotation.y = a
        this.scene.add(face)
      }
      const spire = new THREE.Mesh(new THREE.ConeGeometry(5, 9, 4), new THREE.MeshStandardMaterial({ color: 0x3d2f26, roughness: 0.7 }))
      spire.position.set(x, 34.5, z)
      spire.rotation.y = Math.PI / 4
      this.scene.add(spire)
      this.buildings.push({ minX: x - 3.6, maxX: x + 3.6, minZ: z - 3.6, maxZ: z + 3.6 })
      // Red phone boxes scattered through the quarter
      const boothMat = new THREE.MeshStandardMaterial({ color: 0xb3242a, roughness: 0.5 })
      const bandMat = new THREE.MeshBasicMaterial({ color: 0xfff4d6 })
      const boothRand = seededRand(1963)
      for (let b = 0; b < 6; b++) {
        const k = 1 + Math.floor(boothRand() * 4)
        const bx = -HALF + ROAD / 2 + k * CELL + (ROAD / 2 + 1.6)
        const bz = -HALF + 30 + boothRand() * 150 // London = north-west quadrant (z < 0)
        const booth = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.6, 1.1), boothMat)
        booth.position.set(bx, 1.3, bz)
        booth.castShadow = true
        this.scene.add(booth)
        const band = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.3, 1.16), bandMat)
        band.position.set(bx, 2.25, bz)
        this.scene.add(band)
        this.buildings.push({ minX: bx - 0.6, maxX: bx + 0.6, minZ: bz - 0.6, maxZ: bz + 0.6 })
      }
    }

    // ---- BEIJING: golden pagoda + red lantern streets ----
    {
      const { x, z } = lot(7, 3, 1, 0)
      const columnMat = new THREE.MeshStandardMaterial({ color: 0x9e2b25, roughness: 0.6 })
      const roofMat = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.35, metalness: 0.4, emissive: 0x604010, emissiveIntensity: 0.25 })
      let y = 0
      for (let tier = 0; tier < 4; tier++) {
        const w = 9 - tier * 1.6
        const h = 3.4 - tier * 0.3
        const body = new THREE.Mesh(new THREE.BoxGeometry(w * 0.62, h, w * 0.62), columnMat)
        body.position.set(x, y + h / 2, z)
        body.castShadow = true
        this.scene.add(body)
        const roof = new THREE.Mesh(new THREE.ConeGeometry(w * 0.78, 1.7, 4), roofMat)
        roof.position.set(x, y + h + 0.85, z)
        roof.rotation.y = Math.PI / 4
        this.scene.add(roof)
        y += h + 1.15
      }
      const finial = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 8), roofMat)
      finial.position.set(x, y + 0.8, z)
      this.scene.add(finial)
      this.buildings.push({ minX: x - 3.2, maxX: x + 3.2, minZ: z - 3.2, maxZ: z + 3.2 })
      // Lantern strings: two north-south avenues, glowing red orbs with a sag
      const lanternGeom = new THREE.SphereGeometry(0.38, 8, 8)
      const lanternMat = new THREE.MeshStandardMaterial({ color: 0xd93a2e, emissive: 0xff3524, emissiveIntensity: 1.4, roughness: 0.5 })
      const positions: THREE.Vector3[] = []
      for (const roadK of [7, 8]) {
        const rx = -HALF + ROAD / 2 + roadK * CELL
        for (let zPos = -176; zPos <= 176; zPos += 5.5) {
          const spanT = ((zPos + HALF) % CELL) / CELL
          const sag = Math.sin(spanT * Math.PI) * 1.1
          positions.push(new THREE.Vector3(rx, 7.2 - sag, zPos))
        }
      }
      const lanterns = new THREE.InstancedMesh(lanternGeom, lanternMat, positions.length)
      const lm4 = new THREE.Matrix4()
      positions.forEach((p, idx) => {
        lm4.setPosition(p.x, p.y, p.z)
        lanterns.setMatrixAt(idx, lm4)
      })
      lanterns.instanceMatrix.needsUpdate = true
      this.scene.add(lanterns)
      // Barely-visible cables the lanterns hang from
      const cableMat = new THREE.LineBasicMaterial({ color: 0x1a1418, transparent: true, opacity: 0.7 })
      for (const roadK of [7, 8]) {
        const rx = -HALF + ROAD / 2 + roadK * CELL
        const pts: THREE.Vector3[] = []
        for (let zPos = -176; zPos <= 176; zPos += 2) {
          const spanT = ((zPos + HALF) % CELL) / CELL
          pts.push(new THREE.Vector3(rx, 7.4 - Math.sin(spanT * Math.PI) * 1.1, zPos))
        }
        this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cableMat))
      }
    }

    // ---- CONSTRUCTION YARDS: half-built frames, containers, dirt, mega ramps ----
    {
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x9aa2ad, roughness: 0.7, metalness: 0.3 })
      const slabMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.85 })
      const buildFrame = (fx: number, fz: number) => {
        for (const [ox, oz] of [[-5, -5], [5, -5], [-5, 5], [5, 5]] as const) {
          const colm = new THREE.Mesh(new THREE.BoxGeometry(0.6, 14, 0.6), frameMat)
          colm.position.set(fx + ox, 7, fz + oz)
          colm.castShadow = true
          this.scene.add(colm)
        }
        for (let s = 0; s < 3; s++) {
          const slab = new THREE.Mesh(new THREE.BoxGeometry(11.5, 0.5, 11.5), slabMat)
          slab.position.set(fx, 4.5 + s * 4.5, fz)
          this.scene.add(slab)
        }
        this.buildings.push({ minX: fx - 5.8, maxX: fx + 5.8, minZ: fz - 5.8, maxZ: fz + 5.8 })
      }
      buildFrame(lot(2, 7, 0, 0).x, lot(2, 7, 0, 0).z)
      buildFrame(lot(6, 8, 0, 1).x, lot(6, 8, 0, 1).z)
      // Stunt yard: facing mega ramps with a container gap between them —
      // the whole block is open tarmac
      const sx = blockOrigin(4) + BLOCK / 2
      const sz = blockOrigin(7) + BLOCK / 2
      const rampMat2 = new THREE.MeshStandardMaterial({ color: 0x334155, emissive: 0xf97316, emissiveIntensity: 0.45, roughness: 0.6 })
      const rampN = new THREE.Mesh(new THREE.BoxGeometry(9, 0.7, 10), rampMat2)
      rampN.position.set(sx, 0.95, sz - 8)
      rampN.rotation.x = 0.3
      this.scene.add(rampN)
      this.ramps.push({ x: sx, z: sz - 8, angle: 0 })
      const rampS = new THREE.Mesh(new THREE.BoxGeometry(9, 0.7, 10), rampMat2)
      rampS.position.set(sx, 0.95, sz + 8)
      rampS.rotation.x = -0.3
      this.scene.add(rampS)
      this.ramps.push({ x: sx, z: sz + 8, angle: 0 })
      // Container stacks (jump-over targets) + dirt piles
      const contRand = seededRand(8080)
      const contCols = [0xc0392b, 0x2471a3, 0xb7950b, 0x1e8449]
      for (let c = 0; c < 7; c++) {
        const cm = new THREE.Mesh(
          new THREE.BoxGeometry(2.4, 2.6, 6),
          new THREE.MeshStandardMaterial({ color: contCols[c % contCols.length], roughness: 0.7, metalness: 0.25 })
        )
        const cx = sx - 12 + contRand() * 24
        const cz = sz - 3 + contRand() * 6
        cm.position.set(cx, 1.3 + (c % 2) * 2.6, cz)
        cm.rotation.y = (contRand() - 0.5) * 0.5
        cm.castShadow = true
        this.scene.add(cm)
        this.buildings.push({ minX: cx - 3, maxX: cx + 3, minZ: cz - 3, maxZ: cz + 3 })
      }
      const dirtMat = new THREE.MeshStandardMaterial({ color: 0x7a5c3d, roughness: 1 })
      for (let dp = 0; dp < 5; dp++) {
        const pile = new THREE.Mesh(new THREE.ConeGeometry(2.6, 2.2, 10), dirtMat)
        const dx = lot(3, 7, 0, 0).x + (contRand() - 0.5) * 26
        const dz = lot(3, 7, 0, 0).z + (contRand() - 0.5) * 26
        pile.position.set(dx, 1.1, dz)
        this.scene.add(pile)
        this.buildings.push({ minX: dx - 2, maxX: dx + 2, minZ: dz - 2, maxZ: dz + 2 })
      }
    }
  }

  // =============== PROPS ===============
  private genHarborProps(rand: () => number): void {
    // Container stacks near the harbor edges
    const cGeom = new THREE.BoxGeometry(6, 2.6, 2.4)
    const cMats = [0xb91c1c, 0x1d4ed8, 0xb45309, 0x15803d, 0x6d28d9].map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, metalness: 0.3 })
    )
    for (let k = 0; k < 16; k++) {
      const south = rand() > 0.4
      const x = (rand() * 2 - 1) * (HALF - 24)
      const z = south ? HALF - 9 - rand() * 4 : -HALF + 9 + rand() * 4
      const stack = 1 + Math.floor(rand() * 2)
      for (let s = 0; s < stack; s++) {
        const box = new THREE.Mesh(cGeom, cMats[Math.floor(rand() * cMats.length)])
        box.position.set(x + (rand() - 0.5) * 2, 1.3 + s * 2.6, z + (rand() - 0.5) * 1.5)
        box.rotation.y = (rand() - 0.5) * 0.5
        this.scene.add(box)
      }
      this.buildings.push({ minX: x - 3.4, maxX: x + 3.4, minZ: z - 1.6, maxZ: z + 1.6 })
    }

    // Harbor cranes on the south edge
    const craneMat = new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.7 })
    for (let k = 0; k < 3; k++) {
      const crane = new THREE.Group()
      const legGeom = new THREE.BoxGeometry(1.4, 26, 1.4)
      const l1 = new THREE.Mesh(legGeom, craneMat); l1.position.set(-5, 13, 0)
      const l2 = new THREE.Mesh(legGeom, craneMat); l2.position.set(5, 13, 0)
      const beam = new THREE.Mesh(new THREE.BoxGeometry(30, 2, 2.4), craneMat)
      beam.position.set(4, 26, 0)
      const cab = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 3.4), craneMat)
      cab.position.set(-2, 24, 0)
      const warn = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8), this.blinkMat)
      warn.position.set(4, 27.6, 0)
      crane.add(l1, l2, beam, cab, warn)
      crane.position.set(-120 + k * 110, 0, HALF - 2)
      this.scene.add(crane)
      this.buildings.push({ minX: crane.position.x - 7, maxX: crane.position.x + 7, minZ: crane.position.z - 2, maxZ: crane.position.z + 2 })
    }
  }

  private genStreetFoliage(): void {
    // Street trees: instanced trunks + layered canopy clusters (reads like a real
    // urban tree line, not cones), with beach palms added on the sand ring.
    const rand = seededRand(808)
    const spots: [number, number][] = []
    for (let k = 0; k <= N; k++) {
      const c = -HALF + ROAD / 2 + k * CELL
      for (let a = -HALF + 14; a < HALF - 10; a += 26) {
        if (rand() < 0.45) continue
        // 3.4m past the road edge: canopies clear the lane by ~1.5m even at max scale
        const off = ROAD / 2 + 3.4
        spots.push([c - off, a + rand() * 6])
        if (rand() < 0.5) spots.push([a + rand() * 6, c + off])
      }
    }
    const trunkGeom = new THREE.CylinderGeometry(0.13, 0.22, 2.6, 6)
    trunkGeom.translate(0, 1.3, 0)
    const canopyGeom = mergeGeometries([
      new THREE.IcosahedronGeometry(1.25, 0).translate(0, 3.3, 0),
      new THREE.IcosahedronGeometry(0.95, 0).translate(0.7, 2.9, 0.25),
      new THREE.IcosahedronGeometry(0.85, 0).translate(-0.6, 2.95, -0.3),
      new THREE.IcosahedronGeometry(0.7, 0).translate(0.1, 3.9, -0.15),
    ])!
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 0.95 })
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0x1e4d2b, roughness: 0.9, flatShading: true })
    const trunks = new THREE.InstancedMesh(trunkGeom, trunkMat, spots.length)
    const canopies = new THREE.InstancedMesh(canopyGeom, canopyMat, spots.length)
    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const eu = new THREE.Euler()
    spots.forEach(([x, z], i) => {
      const s = 0.9 + rand() * 0.6
      eu.set(0, rand() * Math.PI * 2, 0)
      q.setFromEuler(eu)
      m4.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s * (0.9 + rand() * 0.3), s))
      trunks.setMatrixAt(i, m4)
      canopies.setMatrixAt(i, m4)
      this.buildings.push({ minX: x - 0.5, maxX: x + 0.5, minZ: z - 0.5, maxZ: z + 0.5 })
    })
    trunks.instanceMatrix.needsUpdate = true
    canopies.instanceMatrix.needsUpdate = true
    trunks.castShadow = true
    canopies.castShadow = true
    this.scene.add(trunks, canopies)

    // Beach palms — continuous curved trunk + dense crown sitting ON the trunk top.
    // (The old staircase segments left gaps and the crown floated offset from the trunk.)
    const palmSpots: [number, number][] = []
    const beachInner = HALF + 5.5
    let guard = 0
    while (palmSpots.length < 140 && guard++ < 900) {
      const side = Math.floor(rand() * 4)
      const along = (rand() * 2 - 1) * (HALF + 6)
      const out = beachInner + 2 + rand() * 22
      const px = side === 0 ? along : side === 1 ? along : side === 2 ? out : -out
      const pz = side === 0 ? out : side === 1 ? -out : along
      // keep a clear lane around the shore spawn point (8, 226)
      if ((px - 8) ** 2 + (pz - 226) ** 2 < 14 * 14) continue
      palmSpots.push([px, pz])
    }
    const PH = 6.4 // trunk height
    const LEAN = 2.3 // sideways bend at the top
    const curveX = (t: number) => LEAN * t * t
    const palmTrunkParts: THREE.BufferGeometry[] = []
    const palmCrownParts: THREE.BufferGeometry[] = []
    const segs = 6
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs
      const t1 = (s + 1) / segs
      const x0 = curveX(t0)
      const x1 = curveX(t1)
      const y0 = t0 * PH
      const y1 = t1 * PH
      const dx = x1 - x0
      const dy = y1 - y0
      const chord = Math.hypot(dx, dy)
      const rBot = 0.17 * (1 - t0 * 0.55)
      const rTop = 0.17 * (1 - t1 * 0.55)
      const seg = new THREE.CylinderGeometry(rTop, rBot, chord * 1.3, 5)
      seg.translate(0, chord * 1.3 / 2 - chord * 0.15, 0) // overlap the joint below
      seg.rotateZ(-Math.atan2(dx, dy))
      seg.translate(x0, y0, 0)
      palmTrunkParts.push(seg)
    }
    const topX = curveX(1)
    // crown: 11 radiating fronds + 3 coconuts, all anchored at the trunk top
    for (let f = 0; f < 11; f++) {
      const frond = new THREE.ConeGeometry(0.13, 3.1, 4)
      frond.translate(0, 1.35, 0)
      frond.rotateX(Math.PI / 2.25 + (f % 3) * 0.14) // alternate droop
      frond.rotateY((f / 11) * Math.PI * 2 + (f % 2) * 0.28)
      frond.translate(topX, PH + 0.1, 0)
      palmCrownParts.push(frond)
    }
    for (let cn = 0; cn < 3; cn++) {
      const nut = new THREE.SphereGeometry(0.15, 5, 5)
      nut.translate(topX + Math.cos(cn * 2.1) * 0.24, PH - 0.1, Math.sin(cn * 2.1) * 0.24)
      palmCrownParts.push(nut)
    }
    const palmTrunkGeom = mergeGeometries(palmTrunkParts)!
    const palmCrownGeom = mergeGeometries(palmCrownParts)!
    const trunkMat2 = new THREE.MeshStandardMaterial({ color: 0x7a6248, roughness: 0.95 })
    const frondMat = new THREE.MeshStandardMaterial({ color: 0x2f7a40, roughness: 0.85, flatShading: true })
    const palmTrunks = new THREE.InstancedMesh(palmTrunkGeom, trunkMat2, palmSpots.length)
    const palmCrowns = new THREE.InstancedMesh(palmCrownGeom, frondMat, palmSpots.length)
    palmSpots.forEach(([x, z], i) => {
      const s = 1.1 + rand() * 0.6
      eu.set(0, rand() * Math.PI * 2, 0)
      q.setFromEuler(eu)
      m4.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s, s))
      palmTrunks.setMatrixAt(i, m4)
      palmCrowns.setMatrixAt(i, m4)
    })
    palmTrunks.instanceMatrix.needsUpdate = true
    palmCrowns.instanceMatrix.needsUpdate = true
    palmTrunks.castShadow = true
    palmCrowns.castShadow = true
    this.scene.add(palmTrunks, palmCrowns)
  }

  private genBillboards(): void {
    const ads: [string, string][] = [
      ['KIRIN COLA', '#22d3ee'],
      ['VOLT-9', '#facc15'],
      ['初 光', '#ff2d95'],
      ['HARBOR GP', '#a3e635'],
      ['NEON TEA', '#c084fc'],
      ['ドック7', '#fb923c'],
      ['SKYLINE FM', '#38bdf8'],
    ]
    const rand = seededRand(99)
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.8 })
    ads.forEach(([text, color], i) => {
      const tex = makeSignTexture(text, color)
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(11, 5.5),
        new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
      )
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 12, 6), poleMat)
      const k = 1 + Math.floor(rand() * (N - 1))
      const along = (rand() * 2 - 1) * (HALF - 50)
      const vertical = rand() > 0.5
      const c = -HALF + ROAD / 2 + k * CELL
      const x = vertical ? c + ROAD / 2 + 2.5 : along
      const z = vertical ? along : c - ROAD / 2 - 2.5
      panel.position.set(x, 13, z)
      panel.rotation.y = vertical ? Math.PI / 2 : 0
      if (rand() > 0.5) panel.rotation.y += Math.PI
      pole.position.set(x, 6, z)
      this.scene.add(panel, pole)
      this.buildings.push({ minX: x - 0.6, maxX: x + 0.6, minZ: z - 0.6, maxZ: z + 0.6 })
      void i
    })
  }

  private genSkyline(): void {
    // Distant skyline outside the playable area — windowed facades, rooftop
    // tiers and antenna spires, so the horizon reads as a working city.
    const rand = seededRand(2024)
    const facade = (() => {
      const c = document.createElement('canvas')
      c.width = 128; c.height = 256
      const g = c.getContext('2d')
      if (!g) return null
      g.fillStyle = '#232b38'
      g.fillRect(0, 0, 128, 256)
      const cols = 8, rows = 22
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const lit = rand() < 0.38
          g.fillStyle = lit ? (rand() < 0.7 ? '#ffd489' : '#bfe0ff') : '#151b26'
          g.fillRect(6 + x * 15, 8 + y * 11, 9, 6)
        }
      }
      return new THREE.CanvasTexture(c)
    })()
    const geom = new THREE.BoxGeometry(1, 1, 1)
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: facade ?? undefined, emissive: 0xffffff,
      emissiveMap: facade ?? undefined, emissiveIntensity: 0.55, roughness: 0.9,
    })
    this.scene.userData.skylineMat = mat // theme hook: dim window glow by day
    const count = 64
    const inst = new THREE.InstancedMesh(geom, mat, count * 2)
    const m4 = new THREE.Matrix4()
    let idx = 0
    const antennaSpots: { x: number; z: number; y: number; h: number }[] = []
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + rand() * 0.1
      const r = 480 + rand() * 260
      // Dense, taller CBD cluster across the bay (south-west) — the horizon
      // reads like a harbour city still being built
      const bias = Math.cos(ang - 2.5) * 0.5 + 0.5
      const h = (50 + rand() * 130) * (1 + bias * 0.85)
      const w = 24 + rand() * 40
      const x = Math.cos(ang) * r
      const z = Math.sin(ang) * r
      m4.makeScale(w, h, w)
      m4.setPosition(x, h / 2 - 2, z)
      inst.setMatrixAt(idx++, m4)
      // rooftop setback tier on the taller towers
      if (h > 90) {
        const th = h * (0.18 + rand() * 0.14)
        m4.makeScale(w * 0.55, th, w * 0.55)
        m4.setPosition(x, h - 2 + th / 2, z)
        inst.setMatrixAt(idx++, m4)
      }
      if (rand() < 0.5) antennaSpots.push({ x, z, y: h - 2 + (h > 90 ? h * 0.25 : 0), h: 12 + rand() * 18 })
    }
    inst.count = idx
    inst.instanceMatrix.needsUpdate = true
    this.scene.add(inst)
    const antGeom = new THREE.CylinderGeometry(0.4, 0.8, 1, 4)
    const antMat = new THREE.MeshStandardMaterial({ color: 0x39424e, roughness: 0.8 })
    const ants = new THREE.InstancedMesh(antGeom, antMat, Math.max(antennaSpots.length, 1))
    antennaSpots.forEach((a, i) => {
      m4.makeScale(1, a.h, 1)
      m4.setPosition(a.x, a.y + a.h / 2, a.z)
      ants.setMatrixAt(i, m4)
    })
    ants.instanceMatrix.needsUpdate = true
    this.scene.add(ants)

    // Tower cranes on the tallest towers — construction across the bay
    const craneMat = new THREE.MeshStandardMaterial({ color: 0xe07b3f, roughness: 0.6, emissive: 0x7a2f08, emissiveIntensity: 0.35 })
    const craneList = antennaSpots.filter(() => rand() < 0.4).slice(0, 10)
    const mastGeom = new THREE.BoxGeometry(0.9, 1, 0.9)
    const boomGeom = new THREE.BoxGeometry(1, 0.5, 0.5)
    const cabGeom = new THREE.BoxGeometry(1.6, 1.4, 1.2)
    const cq = new THREE.Quaternion()
    const ce = new THREE.Euler()
    const one = new THREE.Vector3(1, 1, 1)
    const mastMesh = new THREE.InstancedMesh(mastGeom, craneMat, Math.max(craneList.length, 1))
    const boomMesh = new THREE.InstancedMesh(boomGeom, craneMat, Math.max(craneList.length, 1))
    const cabMesh = new THREE.InstancedMesh(cabGeom, craneMat, Math.max(craneList.length, 1))
    craneList.forEach((cr, i) => {
      const mastH = Math.max(cr.y - 6, 10)
      ce.set(0, 0, 0)
      cq.setFromEuler(ce)
      m4.compose(new THREE.Vector3(cr.x, 6 + mastH / 2, cr.z), cq, new THREE.Vector3(1, mastH, 1))
      mastMesh.setMatrixAt(i, m4)
      ce.set(0, Math.atan2(-cr.x, -cr.z), 0)
      cq.setFromEuler(ce)
      const bl = 22 + rand() * 16
      m4.compose(new THREE.Vector3(cr.x + Math.sin(ce.y) * bl / 2, cr.y, cr.z + Math.cos(ce.y) * bl / 2), cq, new THREE.Vector3(1, 1, bl))
      boomMesh.setMatrixAt(i, m4)
      m4.compose(new THREE.Vector3(cr.x, cr.y - 2.5, cr.z), cq, one)
      cabMesh.setMatrixAt(i, m4)
    })
    mastMesh.instanceMatrix.needsUpdate = true
    boomMesh.instanceMatrix.needsUpdate = true
    cabMesh.instanceMatrix.needsUpdate = true
    this.scene.add(mastMesh, boomMesh, cabMesh)
    // Blinking crane beacons (share the synced rooftop blink)
    const beaconMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.7, 6, 6), this.blinkMat, Math.max(craneList.length, 1))
    craneList.forEach((cr, i) => {
      ce.set(0, 0, 0)
      cq.setFromEuler(ce)
      m4.compose(new THREE.Vector3(cr.x, cr.y + 3.5, cr.z), cq, one)
      beaconMesh.setMatrixAt(i, m4)
    })
    beaconMesh.instanceMatrix.needsUpdate = true
    this.scene.add(beaconMesh)
  }

  // =============== WORLD CIRCUIT (v2) ===============
  /** Build the per-zone hero landmarks (distant silhouettes on the skyline
      ring). One group is visible at a time; the rest stay hidden. */
  private initWorldCircuit(): void {
    this.buildZoneLandmarks()
    const st = zoneAt(this.hooks.getSave().worldKm ?? 0)
    this.worldKm = this.hooks.getSave().worldKm ?? 0
    this.lastZoneId = st.zone.id
    // Seed the current zone's look silently (no banner on boot)
    this.applyZoneMood(st.zone, false)
  }

  private box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, emissive = 0, ei = 0): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.85, emissive, emissiveIntensity: ei })
    )
    m.position.set(x, y, z)
    return m
  }

  /** One architecture pack per city, built from the SAME physical placements
      (collision untouched). Each zone gets its own roof silhouette, window
      grid, neon mood, balconies and street lights, so London never reads as
      Tokyo. All packs live in the scene; applyZoneMood shows only the active
      one. */
  private buildZoneCityVisuals(zone: WorldZone, placements: Placement[], marketPlacements: Placement[]): void {
    const arch = zone.arch
    if (!arch) return
    // Skyline silhouette DNA — each city reshapes the same footprints:
    // a seeded per-building height multiplier (London flattens, NY rises).
    const hp = arch.heightProfile ?? { base: 1, spread: 0, towerChance: 0, towerScale: 1 }
    const hRand = seededRand(5300 + arch.winOffset)
    const hMap = new Map<Placement, number>()
    for (const p of placements) {
      let s = hp.base + (hRand() - 0.5) * 2 * hp.spread
      if (hRand() < hp.towerChance) s *= hp.towerScale
      hMap.set(p, Math.max(0.4, Math.min(s, 3.4)))
    }
    this.zoneHMaps.set(zone.id, hMap)
    const hOf = (p: Placement): number => hMap.get(p) ?? 1
    const city = new THREE.Group()
    const m4 = new THREE.Matrix4()
    const col = new THREE.Color()
    const pos = new THREE.Vector3()
    const scl = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const yAxis = new THREE.Vector3(0, 1, 0)

    // 1) Building shells — zone mood tint (same geometry, own character)
    //    Weathered facade texture: the same flat boxes get brick/plaster/
    //    stone/concrete skins, so walls read as material, not paint.
    const facadeMat = this.assets.cityMaterial.clone()
    const ft = makeFacadeTexture(arch.facadeKind ?? 'concrete', arch.facadeBase ?? 0x8a8a8a, arch.facadeAccent ?? 0x3a3f4a)
    facadeMat.map = ft
    const byModel = new Map<string, Placement[]>()
    for (const p of placements) {
      const list = byModel.get(p.model) ?? []
      list.push(p)
      byModel.set(p.model, list)
    }
    for (const [model, list] of byModel) {
      const cm = this.assets.city[model]
      if (!cm) continue
      const inst = new THREE.InstancedMesh(cm.geometry, facadeMat, list.length)
      inst.castShadow = true
      inst.receiveShadow = true
      list.forEach((p, idx) => {
        const rot90 = p.rot % 2 === 1
        const bw = rot90 ? cm.size.z : cm.size.x
        const bd = rot90 ? cm.size.x : cm.size.z
        const hv = hOf(p)
        const mass = arch.mass ?? 1
        scl.set(w_safe(p.w, bw) * mass, (p.h * hv) / cm.size.y, w_safe(p.d, bd) * mass)
        quat.setFromAxisAngle(yAxis, p.rot * Math.PI * 0.5)
        pos.set(p.x, -cm.minY * scl.y, p.z)
        m4.compose(pos, quat, scl)
        inst.setMatrixAt(idx, m4)
        // bright tint keeps the baked facade color vivid; the mood only
        // shifts it slightly (cool at night, warm at dusk) instead of
        // painting over the material
        const t = 0.78 + 0.22 * p.tint
        col.setRGB(t * (0.82 + 0.18 * zone.mood[0]), t * (0.82 + 0.18 * zone.mood[1]), t * (0.82 + 0.18 * zone.mood[2]))
        inst.setColorAt(idx, col)
      })
      inst.instanceMatrix.needsUpdate = true
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true
      city.add(inst)
    }

    // 1.8) Street-level architecture — the parts a driver actually SEES.
    //      Every city gets its own facade objects: London bay windows, Paris
    //      iron balconies, Beijing hutong walls, Mumbai verandah ledges,
    //      Tokyo exterior staircases, New York fire escapes, Harbor warehouse
    //      doors. Plus a lit shopfront band on the avenue side of every
    //      building. This is form, not paint — the two streets can't be mixed
    //      up even at 60km/h.
    {
      const laneC = (l: number) => -HALF + ROAD / 2 + l * CELL
      const laneXs = [3, 4, 5, 6].map(laneC)
      // storefront body + glowing sign strip (shared geometries, per-city color)
      const sfGeom = new THREE.BoxGeometry(1, 2.7, 0.8)
      const sfMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 })
      const sgGeom = new THREE.BoxGeometry(0.95, 0.6, 0.7)
      const sgMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false })
      type SFP = { x: number; z: number; w: number; d: number; rot: number; h: number; y?: number }
      const sfList: SFP[] = []
      const sfRots: number[] = []
      const sgList: SFP[] = []
      const sgRots: number[] = []
      // per-city feature builders: each adds to (featList, featRots, featMat, geom)
      const featGeoms: { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial; list: Placement[]; rots: number[] }[] = []
      const addFeat = (geo: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial) => {
        const slot = { geo, mat, list: [] as Placement[], rots: [] as number[] }
        featGeoms.push(slot)
        return slot
      }
      const fBase = arch.facadeBase ?? 0x8a8a8a
      const fAcc = arch.facadeAccent ?? 0x3a3f4a
      const sfBase = (zone.id === 'harbor') ? 0x1a2632 : (zone.id === 'london') ? 0x2a2a30 : (zone.id === 'paris') ? 0x2f2720 : (zone.id === 'beijing') ? 0x7b2d43 : (zone.id === 'mumbai') ? 0x1e1612 : (zone.id === 'tokyo') ? 0x14161c : 0x11151d
      const sgColor = (zone.id === 'harbor') ? 0x22d3ee : (zone.id === 'london') ? 0xfde047 : (zone.id === 'paris') ? 0xffd9a0 : (zone.id === 'beijing') ? 0xefb63c : (zone.id === 'mumbai') ? 0xff7f6b : (zone.id === 'tokyo') ? 0xff6aa7 : 0xfde047
      const bay = addFeat(new THREE.BoxGeometry(1.4, 3.4, 0.8), new THREE.MeshStandardMaterial({ color: 0xe8e8f0, roughness: 0.5 }))          // london
      const balc = addFeat(new THREE.BoxGeometry(1, 0.42, 0.3), new THREE.MeshStandardMaterial({ color: 0x1a1e24, roughness: 0.7 }))        // paris
      const huto = addFeat(new THREE.BoxGeometry(1, 1.7, 1), new THREE.MeshStandardMaterial({ color: 0x6a6a6a, roughness: 0.9 }))           // beijing
      const vera = addFeat(new THREE.BoxGeometry(1, 0.34, 0.6), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }))        // mumbai
      const stair = addFeat(new THREE.BoxGeometry(1.3, 0.32, 3.6), new THREE.MeshStandardMaterial({ color: 0x8a93a6, roughness: 0.6 }))    // tokyo
      const fire = addFeat(new THREE.BoxGeometry(1, 0.32, 1.0), new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.4, metalness: 0.3 })) // newyork
      const whDoor = addFeat(new THREE.BoxGeometry(3.4, 4.4, 0.34), new THREE.MeshStandardMaterial({ color: 0x11141f, roughness: 0.8 }))   // harbor
      for (const [model, list] of byModel) {
        const cm = this.assets.city[model]
        if (!cm) continue
        for (const p of list) {
          const rot90 = p.rot % 2 === 1
          const bw = rot90 ? cm.size.z : cm.size.x
          const bd = rot90 ? cm.size.x : cm.size.z
          const hv = hOf(p)
          const h = p.h * hv
          if (h < 4.5) {
            // low buildings: Beijing courtyard wall wrap
            if (zone.id === 'beijing' && h > 1.6) {
              huto.list.push(p); huto.rots.push(p.rot)
            }
            if (zone.id === 'harbor' && h > 3) {
              whDoor.list.push(p); whDoor.rots.push(p.rot)
            }
            continue
          }
          // avenue-facing direction
          const cx = p.x
          const cz = p.z
          let best = 1e9
          let ddx = 0
          let ddz = 0
          for (const lc of laneXs) {
            const dx = Math.abs(cx - lc)
            const dz = Math.abs(cz - lc)
            if (dz < best) { best = dz; ddx = 0; ddz = 1 }
            if (dx < best) { best = dx; ddx = 1; ddz = 0 }
          }
          const signX = ddx !== 0 ? (cx < 0 ? -1 : 1) : 0
          const signZ = ddz !== 0 ? (cz < 0 ? -1 : 1) : 0
          const half = (ddx !== 0 ? bw : bd) / 2
          const fx = cx + signX * (half + 0.35)
          const fz = cz + signZ * (half + 0.35)
          const ry = ddx !== 0 ? (signX < 0 ? Math.PI / 2 : -Math.PI / 2) : (signZ < 0 ? Math.PI : 0)
          const sfr: SFP = { x: fx, z: fz, w: Math.min(bw, bd, 12), d: 0.8, rot: 0, h }
          sfList.push(sfr)
          sfRots.push(ry)
          sgList.push({ ...sfr, y: 2.85 })
          sgRots.push(ry)
          // facade features per city
          const fr = 1.9 + Math.sin(p.x * 3.1 + p.z * 7.7) * 0.6 // deterministic per building
          if (zone.id === 'london' && h > 7 && fr > 2.1) { bay.list.push(p); bay.rots.push(p.rot) }
          if (zone.id === 'paris' && h > 6) { balc.list.push(p); balc.rots.push(p.rot) }
          if (zone.id === 'mumbai' && h > 6) { vera.list.push(p); vera.rots.push(p.rot) }
          if (zone.id === 'tokyo' && h > 5) { stair.list.push(p); stair.rots.push(p.rot) }
          if (zone.id === 'newyork' && h > 8) { fire.list.push(p); fire.rots.push(p.rot) }
        }
      }
      const placeInst = (list: SFP[], rots: number[], geo: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial, yBase: number, wide: boolean) => {
        if (list.length === 0) return
        const inst = new THREE.InstancedMesh(geo, mat, list.length)
        inst.castShadow = true
        inst.receiveShadow = true
        list.forEach((p, i) => {
          const r = rots[i] ?? 0
          const wfac = wide ? Math.max(0.4, Math.min(p.w, 12)) : 1
          scl.set(wide ? wfac : 1, 1, wide ? 1 : 1)
          pos.set(p.x, yBase + (p.y ?? 1.35), p.z)
          quat.setFromAxisAngle(yAxis, r)
          m4.compose(pos, quat, scl)
          inst.setMatrixAt(i, m4)
        })
        inst.instanceMatrix.needsUpdate = true
        city.add(inst)
      }
      sfMat.color.setHex(sfBase)
      sgMat.color.setHex(sgColor)
      placeInst(sfList, sfRots, sfGeom, sfMat, 1.35, true)
      placeInst(sgList, sgRots, sgGeom, sgMat, 2.85, true)
      // per-city features — geometry scaled to the building face
      const featCfg = [
        { slot: bay, y: 2.6, w: false, fw: 0.75, city: 'london' },
        { slot: balc, y: 3.4, w: true, fw: 1, city: 'paris' },
        { slot: huto, y: 0.85, w: true, fw: 1, city: 'beijing' },
        { slot: vera, y: 2.7, w: true, fw: 1, city: 'mumbai' },
        { slot: stair, y: 3.0, w: false, fw: 1, city: 'tokyo' },
        { slot: fire, y: 3.6, w: true, fw: 1, city: 'newyork' },
        { slot: whDoor, y: 2.2, w: false, fw: 1, city: 'harbor' },
      ]
      for (const cfg of featCfg) {
        if (cfg.slot.list.length === 0 || zone.id !== cfg.city) continue
        const inst = new THREE.InstancedMesh(cfg.slot.geo, cfg.slot.mat, cfg.slot.list.length)
        cfg.slot.list.forEach((p, i) => {
          const rot90 = p.rot % 2 === 1
          const bw = (rot90 ? p.d : p.w) * (arch.mass ?? 1)
          scl.set(cfg.w ? Math.max(0.5, bw * 0.8) : 1, 1, 1)
          pos.set(p.x, cfg.y, p.z)
          quat.setFromAxisAngle(yAxis, p.rot * Math.PI * 0.5)
          m4.compose(pos, quat, scl)
          inst.setMatrixAt(i, m4)
        })
        inst.instanceMatrix.needsUpdate = true
        city.add(inst)
      }
      void fBase
      void fAcc
    }

    // 1.9) Road markings — the asphalt belongs to the city too. New York's
    //      yellow double centre line, London's red bus lane, Paris's green
    //      bike lane, Beijing's red kerbs, Mumbai's faded yellow, Tokyo's
    //      blue edge lines, Harbor's cyan port guide. A driver looks at the
    //      road the whole run — so the road itself must read as the city.
    {
      const laneC = (l: number) => -HALF + ROAD / 2 + l * CELL
      const markMat = (c: number) => new THREE.MeshBasicMaterial({ color: c, fog: false })
      const addStrip = (mat: THREE.MeshBasicMaterial, w: number, off: number, y = 0.035) => {
        const hGeom = new THREE.BoxGeometry(w, 0.06, 0.55)
        const vGeom = new THREE.BoxGeometry(0.55, 0.06, w)
        for (const l of [3, 4, 5, 6]) {
          const c = laneC(l)
          const hm = new THREE.Mesh(hGeom, mat); hm.position.set(0, y, c + off); city.add(hm)
          const vm = new THREE.Mesh(vGeom, mat); vm.position.set(c + off, y, 0); city.add(vm)
        }
      }
      const zid = zone.id
      if (zid === 'newyork') {
        const yellow = markMat(0xf5a623)
        addStrip(yellow, 340, -0.55)
        addStrip(yellow, 340, 0.55)
      } else if (zid === 'london') {
        addStrip(markMat(0xc0392b), 340, 2.4)   // red bus lane on the outside
        addStrip(markMat(0xdfe4ea), 340, 0)      // crisp white centre
      } else if (zid === 'paris') {
        addStrip(markMat(0x3f7a6e), 300, -2.6)   // green bike lane
        addStrip(markMat(0xdfe4ea), 340, 0.4)
      } else if (zid === 'beijing') {
        addStrip(markMat(0x8a2020), 340, ROAD / 2 - 0.8)   // red kerbs
        addStrip(markMat(0x8a2020), 340, -(ROAD / 2 - 0.8))
        addStrip(markMat(0xdfe4ea), 340, 0)
      } else if (zid === 'mumbai') {
        addStrip(markMat(0xd4a017), 340, 0)      // faded yellow centre
        addStrip(markMat(0x9a8a5a), 300, ROAD / 2 - 0.9)  // dusted edges
      } else if (zid === 'tokyo') {
        addStrip(markMat(0x7fa8c9), 340, 0)      // blue-white lane guide
        addStrip(markMat(0xdfe4ea), 340, 2.2)
      } else if (zid === 'harbor') {
        addStrip(markMat(0x22d3ee), 340, 0)      // cyan port guide line
      }
    }

    // 1.5) Glass-curtain towers — thin lit vertical strips on the tallest
    //      towers (Tokyo / New York / Beijing office canyons at night).
    if (arch.glassStrips) {
      const tallPick = placements
        .map((p, i) => ({ p, i, h: hOf(p) }))
        .sort((a, b) => b.h - a.h)
        .slice(0, 26)
      const stripGeom = new THREE.BoxGeometry(0.24, 1, 0.24)
      const stripMat = new THREE.MeshBasicMaterial({ color: 0xbfe6ff })
      const strips = new THREE.InstancedMesh(stripGeom, stripMat, tallPick.length * 2)
      tallPick.forEach(({ p, h: hv }, idx) => {
        const rot = p.rot * Math.PI * 0.5
        const cosR = Math.cos(rot)
        const sinR = Math.sin(rot)
        for (const side of [-1, 1]) {
          const lx = side * (p.w / 2 - 0.45)
          const lz = side * (p.d / 2 - 0.45)
          const x = p.x + lx * cosR + lz * sinR
          const z = p.z - lx * sinR + lz * cosR
          m4.makeScale(1, hv, 1)
          m4.setPosition(x, hv / 2, z)
          strips.setMatrixAt(idx * 2 + (side < 0 ? 0 : 1), m4)
        }
      })
      strips.instanceMatrix.needsUpdate = true
      city.add(strips)
    }

    // 1.7) Rooftop clutter — AC units on every city's roofs (the COD-look:
    //      lived-in, littered skyline, not clean boxes)
    {
      const acGeom = new THREE.BoxGeometry(1.5, 0.9, 1.2)
      const acMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.85, metalness: 0.1 })
      const fanGeom = new THREE.CylinderGeometry(0.3, 0.3, 0.16, 10)
      const fanMat = new THREE.MeshStandardMaterial({ color: 0x353a44, roughness: 0.6, metalness: 0.4 })
      const clutter = placements.filter((p) => hOf(p) > 0.8 && hOf(p) < 2.6)
      const acRand = seededRand(9901 + arch.winOffset)
      const aces = new THREE.InstancedMesh(acGeom, acMat, Math.max(clutter.length, 1))
      const fans = new THREE.InstancedMesh(fanGeom, fanMat, Math.max(clutter.length, 1))
      let ai = 0
      clutter.forEach((p) => {
        if (acRand() > 0.5) return
        const h = p.h * hOf(p)
        const qu2 = new THREE.Quaternion()
        qu2.setFromAxisAngle(yAxis, p.rot * Math.PI * 0.5 + (acRand() - 0.5) * 0.6)
        const ox = (acRand() - 0.5) * p.w * 0.5
        const oz = (acRand() - 0.5) * p.d * 0.5
        const y = h + 0.45
        const r90 = p.rot % 2 === 1
        const bw = r90 ? p.d : p.w
        const bd = r90 ? p.w : p.d
        const x = p.x + ox
        const z = p.z + oz
        scl.set(1, 1, 1)
        pos.set(x, y, z)
        m4.compose(pos, qu2, scl)
        aces.setMatrixAt(ai, m4)
        pos.set(x, y + 0.42, z)
        m4.compose(pos, qu2, scl)
        fans.setMatrixAt(ai, m4)
        ai++
        void bw
        void bd
      })
      aces.count = ai
      fans.count = ai
      aces.instanceMatrix.needsUpdate = true
      fans.instanceMatrix.needsUpdate = true
      if (ai > 0) {
        city.add(aces)
        city.add(fans)
      }
    }

    // 2) Roof silhouettes — the strongest per-city read. Every style uses the
    //    same footprint so the city skyline CHANGES SHAPE between cities.
    const capGeom = new THREE.BoxGeometry(1, 1, 1)
    const capMat = new THREE.MeshStandardMaterial({ color: arch.cap, roughness: 0.85 })
    const roofRand = seededRand(4242 + arch.winOffset)
    if (arch.roof === 'pitched') {
      // slate pyramid roofs + chimney stacks (London terrace houses)
      const coneGeom = new THREE.ConeGeometry(1, 1, 4)
      const pitchMat = new THREE.MeshStandardMaterial({ color: 0x2f3540, roughness: 0.9 })
      const pitches = new THREE.InstancedMesh(coneGeom, pitchMat, Math.max(placements.length, 1))
      const chimGeom = new THREE.BoxGeometry(0.7, 1.7, 0.7)
      const chimMat = new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.9 })
      const chims = new THREE.InstancedMesh(chimGeom, chimMat, Math.max(placements.length, 1))
      placements.forEach((p, idx) => {
        m4.makeScale(p.w * 0.98, 2.2, p.d * 0.98)
        m4.setPosition(p.x, hOf(p) + 1.1, p.z)
        pitches.setMatrixAt(idx, m4)
        if (roofRand() < 0.45) { m4.makeScale(1, 1, 1); m4.setPosition(p.x + p.w * 0.22, hOf(p) + 0.85, p.z - p.d * 0.18); chims.setMatrixAt(idx, m4) }
      })
      pitches.instanceMatrix.needsUpdate = true
      chims.instanceMatrix.needsUpdate = true
      city.add(pitches, chims)
    } else if (arch.roof === 'mansard') {
      // tall slate cap + small dormer crown (Paris Haussmann)
      const caps = new THREE.InstancedMesh(capGeom, capMat, Math.max(placements.length, 1))
      const dormGeom = new THREE.BoxGeometry(1, 1, 1)
      const dormMat = new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.9 })
      const dorms = new THREE.InstancedMesh(dormGeom, dormMat, Math.max(placements.length, 1))
      placements.forEach((p, idx) => {
        m4.makeScale(p.w + 0.5, 2.6, p.d + 0.5)
        m4.setPosition(p.x, hOf(p) + 1.3, p.z)
        caps.setMatrixAt(idx, m4)
        m4.makeScale(p.w * 0.55, 1.0, p.d * 0.55)
        m4.setPosition(p.x, hOf(p) + 3.15, p.z)
        dorms.setMatrixAt(idx, m4)
      })
      caps.instanceMatrix.needsUpdate = true
      dorms.instanceMatrix.needsUpdate = true
      city.add(caps, dorms)
    } else if (arch.roof === 'pagoda') {
      // gold upturned pyramid + finial (Beijing)
      const coneGeom = new THREE.ConeGeometry(1, 1, 4)
      const pagodaMat = new THREE.MeshStandardMaterial({ color: 0xcfb457, emissive: 0x8a6a1e, emissiveIntensity: 0.45, roughness: 0.6 })
      const pagodas = new THREE.InstancedMesh(coneGeom, pagodaMat, Math.max(placements.length, 1))
      const finGeom = new THREE.SphereGeometry(0.55, 8, 8)
      const finMat = new THREE.MeshStandardMaterial({ color: 0xffd23d, emissive: 0x8a6a1e, emissiveIntensity: 0.6 })
      const fins = new THREE.InstancedMesh(finGeom, finMat, Math.max(placements.length, 1))
      placements.forEach((p, idx) => {
        m4.makeScale(p.w * 0.94, 2.4, p.d * 0.94)
        m4.setPosition(p.x, hOf(p) + 1.2, p.z)
        pagodas.setMatrixAt(idx, m4)
        m4.makeScale(1, 1, 1)
        m4.setPosition(p.x, hOf(p) + 2.8, p.z)
        fins.setMatrixAt(idx, m4)
      })
      pagodas.instanceMatrix.needsUpdate = true
      fins.instanceMatrix.needsUpdate = true
      city.add(pagodas, fins)
    } else {
      // flat parapet band — Harbor / Mumbai / Tokyo / New York
      const caps = new THREE.InstancedMesh(capGeom, capMat, Math.max(placements.length, 1))
      placements.forEach((p, idx) => {
        m4.makeScale(p.w + 0.5, 0.55, p.d + 0.5)
        m4.setPosition(p.x, hOf(p) + 0.1, p.z)
        caps.setMatrixAt(idx, m4)
      })
      caps.instanceMatrix.needsUpdate = true
      city.add(caps)

      if (arch.roof === 'parapet' && arch.capGlow !== 0) {
        // neon roofline — Tokyo / New York read as glowing canyons at night
        const glowGeom = new THREE.BoxGeometry(1, 1, 1)
        const glowMat = new THREE.MeshBasicMaterial({ color: arch.capGlow })
        const glows = new THREE.InstancedMesh(glowGeom, glowMat, Math.max(placements.length, 1))
        placements.forEach((p, idx) => {
          m4.makeScale(p.w + 0.8, 0.28, p.d + 0.8)
          m4.setPosition(p.x, hOf(p) + 0.42, p.z)
          glows.setMatrixAt(idx, m4)
        })
        glows.instanceMatrix.needsUpdate = true
        city.add(glows)
      }

      if (arch.roof === 'tank' && (arch.tankChance ?? 0) > 0) {
        const tankGeom = new THREE.CylinderGeometry(1.1, 1.1, 2.4, 10)
        const tankMat = new THREE.MeshStandardMaterial({ color: 0x4a5568, roughness: 0.8 })
        const acGeom = new THREE.BoxGeometry(2, 1.1, 1.4)
        const acMat = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.85 })
        const roofPick = placements.filter((p) => hOf(p) > 14)
        const tankN = Math.max(Math.ceil(roofPick.length * arch.tankChance!), 1)
        const acN = Math.max(roofPick.length - tankN, 1)
        const tanks = new THREE.InstancedMesh(tankGeom, tankMat, tankN)
        const acs = new THREE.InstancedMesh(acGeom, acMat, acN)
        let ti = 0
        let ai = 0
        roofPick.forEach((p) => {
          if (roofRand() < arch.tankChance! && ti < tankN) {
            m4.makeScale(1, 1, 1)
            m4.setPosition(p.x + p.w * 0.22, hOf(p) + 1.2, p.z - p.d * 0.18)
            tanks.setMatrixAt(ti++, m4)
          } else if (ai < acN) {
            m4.makeScale(1, 1, 1)
            m4.setPosition(p.x - p.w * 0.2, hOf(p) + 0.55, p.z + p.d * 0.2)
            acs.setMatrixAt(ai++, m4)
          }
        })
        tanks.instanceMatrix.needsUpdate = true
        acs.instanceMatrix.needsUpdate = true
        city.add(tanks, acs)
      }
    }

    // 3) Window grids — per-city seed + density + warm/cool balance
    const winRand = seededRand(3141 + arch.winOffset)
    const skipBay = arch.roof === 'parapet' && zone.id === 'tokyo' ? 0.08 : zone.id === 'london' ? 0.3 : 0.18
    const winTransforms: { x: number; y: number; z: number; ry: number }[] = []
    const balTransforms: { x: number; y: number; z: number; ry: number }[] = []
    for (const p of placements) {
      if (hOf(p) < 9) continue
      const rows = Math.min(14, Math.floor((hOf(p) - 3) / 2.6))
      if (rows < 2) continue
      const rot = p.rot * Math.PI * 0.5
      const cosR = Math.cos(rot)
      const sinR = Math.sin(rot)
      const colsF = Math.max(2, Math.floor((p.w - 2) / 2.1))
      for (const side of [-1, 1] as const) {
        for (let r = 0; r < rows; r++) {
          for (let cI = 0; cI < colsF; cI++) {
            if (winRand() < skipBay) continue
            const lx = colsF > 1 ? -p.w / 2 + 1.2 + (cI * (p.w - 2.4)) / (colsF - 1) : 0
            const ly = 2.2 + r * 2.6
            const lz = side * (p.d / 2 + 0.06)
            winTransforms.push({
              x: p.x + lx * cosR + lz * sinR,
              y: ly,
              z: p.z - lx * sinR + lz * cosR,
              ry: rot + (side < 0 ? Math.PI : 0),
            })
            if (arch.balcony) balTransforms.push({
              x: p.x + lx * cosR + lz * sinR,
              y: ly - 0.75,
              z: p.z - lx * sinR + lz * cosR,
              ry: rot + (side < 0 ? Math.PI : 0),
            })
          }
        }
      }
    }
    const winGeom = new THREE.PlaneGeometry(1.05, 1.35)
    const winMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    const winInst = new THREE.InstancedMesh(winGeom, winMat, Math.max(winTransforms.length, 1))
    const winWarm = new THREE.Color(zone.win[0])
    const winCool = new THREE.Color(zone.win[1])
    const winDark = new THREE.Color(0x141a26)
    winTransforms.forEach((wI, idx) => {
      quat.setFromAxisAngle(yAxis, wI.ry)
      m4.compose(new THREE.Vector3(wI.x, wI.y, wI.z), quat, scl.set(1, 1, 1))
      winInst.setMatrixAt(idx, m4)
      const lit = winRand() < 0.42
      if (lit) col.copy(winRand() < zone.litWarm ? winWarm : winCool).multiplyScalar(0.75 + winRand() * 0.5)
      else col.copy(winDark)
      winInst.setColorAt(idx, col)
    })
    winInst.instanceMatrix.needsUpdate = true
    if (winInst.instanceColor) winInst.instanceColor.needsUpdate = true
    city.add(winInst)
    this.zoneWinMats.set(zone.id, winMat)

    if (arch.balcony) {
      const balGeom = new THREE.BoxGeometry(1.5, 0.12, 0.34)
      const balMat = new THREE.MeshStandardMaterial({ color: 0x1a1e24, roughness: 0.7, metalness: 0.5 })
      const bals = new THREE.InstancedMesh(balGeom, balMat, Math.max(balTransforms.length, 1))
      balTransforms.forEach((bI, idx) => {
        quat.setFromAxisAngle(yAxis, bI.ry)
        m4.compose(new THREE.Vector3(bI.x, bI.y, bI.z), quat, scl.set(1, 1, 1))
        bals.setMatrixAt(idx, m4)
      })
      bals.instanceMatrix.needsUpdate = true
      city.add(bals)
    }

    if ((arch.stringLights ?? 0) > 0) {
      // Mumbai — strings of warm fairy lights draped along facades
      const festGeom = new THREE.BoxGeometry(0.22, 0.22, 0.22)
      const festMat = new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95, depthWrite: false })
      const festCols = [0xffe9b0, 0xffd9a0, 0xffb3d9, 0x9fd8ff, 0xc8ffd9, 0xfde047]
      const festRand = seededRand(909 + arch.winOffset)
      const festSpots: { x: number; y: number; z: number; ry: number; c: number }[] = []
      for (const p of placements) {
        if (hOf(p) > 30 || hOf(p) < 5) continue
        if (festRand() > arch.stringLights!) continue
        const rot = p.rot * Math.PI * 0.5
        const cosR = Math.cos(rot)
        const sinR = Math.sin(rot)
        const side = festRand() > 0.5 ? 1 : -1
        const n = Math.max(3, Math.floor(p.w / 2.4))
        for (let cI = 0; cI < n; cI++) {
          const lx = n > 1 ? -p.w / 2 + 1.4 + (cI * (p.w - 2.8)) / (n - 1) : 0
          const ly = 3.1 + festRand() * Math.min(6, hOf(p) * 0.4)
          const lz = side * (p.d / 2 + 0.12)
          festSpots.push({
            x: p.x + lx * cosR + lz * sinR,
            y: ly,
            z: p.z - lx * sinR + lz * cosR,
            ry: rot + (side < 0 ? Math.PI : 0),
            c: festCols[Math.floor(festRand() * festCols.length)],
          })
        }
      }
      const fests = new THREE.InstancedMesh(festGeom, festMat, Math.max(festSpots.length, 1))
      festSpots.forEach((s, idx) => {
        quat.setFromAxisAngle(yAxis, s.ry)
        m4.compose(new THREE.Vector3(s.x, s.y, s.z), quat, scl.set(1, 1, 1))
        fests.setMatrixAt(idx, m4)
        col.setHex(s.c)
        fests.setColorAt(idx, col)
      })
      fests.instanceMatrix.needsUpdate = true
      if (fests.instanceColor) fests.instanceColor.needsUpdate = true
      city.add(fests)
    }

    // 3.5) Silhouette dressing — the skyline's signature shapes. Each city
    //      crowns its tallest buildings with its OWN geometry so the skyline
    //      reads differently even at a glance: New York's stepped setback
    //      skyscrapers, Tokyo's needle antennas, Beijing's tiered pagoda
    //      eaves, Mumbai's rooftop tanks + satellite dishes.
    if (arch.setbacks) {
      const picks = placements.filter((p) => hOf(p) > 1.15).slice(0, 34)
      const tierGeom = new THREE.BoxGeometry(1, 1, 1)
      const tierMat = new THREE.MeshStandardMaterial({ color: 0x232e42, roughness: 0.62, metalness: 0.35 })
      const tiers = new THREE.InstancedMesh(tierGeom, tierMat, picks.length * 2)
      picks.forEach((p, idx) => {
        const h = p.h * hOf(p)
        const qu2 = new THREE.Quaternion()
        qu2.setFromAxisAngle(yAxis, p.rot * Math.PI * 0.5)
        const steps = [
          { f: 0.62, y: h * 0.81, hh: h * 0.38 },
          { f: 0.4, y: h * 0.985, hh: h * 0.33 },
        ]
        steps.forEach((st, si) => {
          scl.set(p.w * st.f, st.hh, p.d * st.f)
          pos.set(p.x, st.y, p.z)
          m4.compose(pos, qu2, scl)
          tiers.setMatrixAt(idx * 2 + si, m4)
        })
      })
      tiers.instanceMatrix.needsUpdate = true
      city.add(tiers)
    }
    if (arch.antennas) {
      const picks = placements.filter((p) => hOf(p) > 1.3).slice(0, 30)
      const poleGeom = new THREE.BoxGeometry(0.2, 2.6, 0.2)
      const crossGeom = new THREE.BoxGeometry(1.3, 0.16, 0.16)
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x8a93a6, roughness: 0.5, metalness: 0.6 })
      const poles = new THREE.InstancedMesh(poleGeom, poleMat, Math.max(picks.length, 1))
      const crosses = new THREE.InstancedMesh(crossGeom, poleMat, Math.max(picks.length, 1))
      picks.forEach((p, idx) => {
        const h = p.h * hOf(p)
        const qu2 = new THREE.Quaternion()
        qu2.setFromAxisAngle(yAxis, p.rot * Math.PI * 0.5)
        scl.set(1, 1, 1)
        pos.set(p.x, h + 1.3, p.z)
        m4.compose(pos, qu2, scl)
        poles.setMatrixAt(idx, m4)
        pos.set(p.x, h + 1.75, p.z)
        m4.compose(pos, qu2, scl)
        crosses.setMatrixAt(idx, m4)
      })
      poles.instanceMatrix.needsUpdate = true
      crosses.instanceMatrix.needsUpdate = true
      city.add(poles)
      city.add(crosses)
    }
    if (arch.eaveTiers) {
      const picks = placements
      const eaveGeom = new THREE.BoxGeometry(1, 0.14, 1)
      const eaveMat = new THREE.MeshStandardMaterial({ color: 0xcfb457, roughness: 0.6, metalness: 0.15 })
      const eaves = new THREE.InstancedMesh(eaveGeom, eaveMat, Math.max(picks.length * 2, 1))
      picks.forEach((p, idx) => {
        const h = p.h * hOf(p)
        const qu2 = new THREE.Quaternion()
        qu2.setFromAxisAngle(yAxis, p.rot * Math.PI * 0.5)
        const steps = [
          { f: 1.08, y: h * 0.8 },
          { f: 1.16, y: h * 0.94 },
        ]
        steps.forEach((st, si) => {
          scl.set(p.w * st.f, 1, p.d * st.f)
          pos.set(p.x, st.y, p.z)
          m4.compose(pos, qu2, scl)
          eaves.setMatrixAt(idx * 2 + si, m4)
        })
      })
      eaves.instanceMatrix.needsUpdate = true
      city.add(eaves)
    }
    if (arch.dishes) {
      const picks = placements.filter((p) => hOf(p) > 0.8)
      const dishGeom = new THREE.CylinderGeometry(0.55, 0.55, 0.1, 8)
      const dishMat = new THREE.MeshStandardMaterial({ color: 0x9aa0ad, roughness: 0.5, metalness: 0.4 })
      const dishes = new THREE.InstancedMesh(dishGeom, dishMat, Math.max(picks.length, 1))
      const dRand = seededRand(7766 + arch.winOffset)
      let di = 0
      picks.forEach((p) => {
        if (dRand() > (arch.dishes ?? 0.5)) return
        const h = p.h * hOf(p)
        const qu2 = new THREE.Quaternion()
        qu2.setFromAxisAngle(yAxis, p.rot * Math.PI * 0.5)
        scl.set(1, 1, 1)
        pos.set(p.x + (dRand() - 0.5) * p.w * 0.4, h + 0.45, p.z + (dRand() - 0.5) * p.d * 0.4)
        m4.compose(pos, qu2, scl)
        dishes.setMatrixAt(di, m4)
        di++
      })
      dishes.count = di
      dishes.instanceMatrix.needsUpdate = true
      city.add(dishes)
    }

    // 4) Neon corner trims (Beijing market blocks) + rooftop blinkers
    if (zone.id === 'beijing') {
      const trimGeom = new THREE.BoxGeometry(1, 1, 1)
      const trimMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
      const trims = new THREE.InstancedMesh(trimGeom, trimMat, Math.max(marketPlacements.length * 2, 1))
      const trimRand = seededRand(606)
      const trimPalette = [0xefb63c, 0xff2d95, 0x22d3ee]
      let tri = 0
      marketPlacements.forEach((p) => {
        for (const sx of [-1, 1]) {
          m4.makeScale(0.28, hOf(p) * (0.55 + trimRand() * 0.4), 0.28)
          m4.setPosition(p.x + sx * (p.w / 2 + 0.05), hOf(p) * 0.5, p.z + (p.d / 2 + 0.05))
          trims.setMatrixAt(tri, m4)
          col.setHex(trimPalette[Math.floor(trimRand() * trimPalette.length)])
          trims.setColorAt(tri, col)
          tri++
        }
      })
      trims.instanceMatrix.needsUpdate = true
      if (trims.instanceColor) trims.instanceColor.needsUpdate = true
      city.add(trims)
    }
    const blinkGeom = new THREE.SphereGeometry(0.32, 6, 6)
    const blinkPick = placements.filter((p) => hOf(p) > 24).slice(0, 40)
    const blinkInst = new THREE.InstancedMesh(blinkGeom, this.blinkMat, Math.max(blinkPick.length, 1))
    blinkPick.forEach((p, idx) => {
      m4.makeScale(1, 1, 1)
      m4.setPosition(p.x, hOf(p) + 0.5, p.z)
      blinkInst.setMatrixAt(idx, m4)
    })
    blinkInst.instanceMatrix.needsUpdate = true
    city.add(blinkInst)

    // 5) Neon signs — per-city density + palette
    const neonGeom = new THREE.BoxGeometry(1, 1, 1)
    const neonMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    const neonRand = seededRand(777 + arch.winOffset)
    let neonCount = 0
    for (const p of placements) neonCount += Math.max(1, Math.round(p.signs * arch.neonDensity))
    const neon = new THREE.InstancedMesh(neonGeom, neonMat, Math.max(neonCount, 1))
    let ni = 0
    placements.forEach((p) => {
      const signN = Math.max(1, Math.round(p.signs * arch.neonDensity))
      for (let k = 0; k < signN; k++) {
        const w = 1.5 + neonRand() * 5
        const h = 0.4 + neonRand() * 1.4
        const y = 3 + neonRand() * Math.max(hOf(p) - 4, 4)
        const side = Math.floor(neonRand() * 4)
        let x = p.x
        let z = p.z
        let sx = w
        let sz = 0.35
        if (side === 0) { z = p.z - p.d / 2 - 0.1 } else if (side === 1) { z = p.z + p.d / 2 + 0.1 } else if (side === 2) { x = p.x - p.w / 2 - 0.1; sx = 0.35; sz = w } else { x = p.x + p.w / 2 + 0.1; sx = 0.35; sz = w }
        m4.makeScale(sx, h, sz)
        m4.setPosition(x, y, z)
        neon.setMatrixAt(ni, m4)
        col.setHex(arch.neonPalette[Math.floor(neonRand() * arch.neonPalette.length)])
        neon.setColorAt(ni, col)
        ni++
      }
    })
    neon.instanceMatrix.needsUpdate = true
    if (neon.instanceColor) neon.instanceColor.needsUpdate = true
    city.add(neon)

    // 6) Storefront glow bands — per-city tint
    const shopGeom = new THREE.BoxGeometry(1, 1, 1)
    const shopMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    const shopPick = placements.filter((p) => hOf(p) <= 32)
    const shopInst = new THREE.InstancedMesh(shopGeom, shopMat, Math.max(shopPick.length, 1))
    const shopPalette = [zone.trim, 0xffd9a0, 0x9fd8ff, 0xffb3d9, 0xc8ffd9]
    shopPick.forEach((p, idx) => {
      const side = idx % 2 === 0 ? -1 : 1
      m4.makeScale(p.w * 0.82, 1.1, 0.25)
      m4.setPosition(p.x, 1.0, p.z + side * (p.d / 2 + 0.12))
      shopInst.setMatrixAt(idx, m4)
      col.setHex(shopPalette[idx % shopPalette.length])
      shopInst.setColorAt(idx, col)
    })
    shopInst.instanceMatrix.needsUpdate = true
    if (shopInst.instanceColor) shopInst.instanceColor.needsUpdate = true
    city.add(shopInst)

    // 7) Zone sidewalk people — a small animated street cast per city (see
    //    buildZonePeople for the outfits; grouped here so toggling is free).
    this.buildZonePeople(zone, city)
    // 8) Zone street furniture — the props that make a sidewalk READ as a
    //    place: London phone boxes, Tokyo vending machines, Mumbai stalls.
    this.buildZoneFurniture(zone, city)
    this.buildZoneStreetlife(zone, city)
    this.buildZoneRoadStyle(zone, city)

    city.visible = false
    this.scene.add(city)
    this.zoneCities.set(zone.id, city)
  }

  /** Small animated street cast per city — a handful of sidewalk idlers in
      zone-specific outfits (London dark coats, Mumbai saris, Tokyo business).
      Parented to the zone pack so zone switching hides/shows them for free. */
  private buildZonePeople(zone: WorldZone, parent: THREE.Group): void {
    const arch = zone.arch
    if (!arch) return
    const charKeys = Object.keys(this.assets.chars)
    if (charKeys.length === 0) return
    const rand = seededRand(3033 + arch.winOffset)
    const n = this.lowPower ? 6 : 9
    const wraps: THREE.Group[] = []
    for (let i = 0; i < n; i++) {
      const key = charKeys[Math.floor(rand() * charKeys.length)]
      const { obj, clips } = cloneCharacter(this.assets, key)
      const bb = new THREE.Box3().setFromObject(obj)
      const h = bb.max.y - bb.min.y
      const s = h > 0.01 ? (1.55 + rand() * 0.3) / h : 1
      obj.scale.setScalar(s)
      const skin = new THREE.Color(0xf2c9a0)
      const accent = new THREE.Color(arch.people[Math.floor(rand() * arch.people.length)])
      const jitter = 0.85 + rand() * 0.3
      obj.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        const src = m.material as THREE.MeshStandardMaterial
        const mat = src.clone()
        const label = `${src.name} ${m.name}`.toLowerCase()
        const base = /skin|head/.test(label) ? skin : accent
        mat.color = base.clone().multiplyScalar(jitter)
        mat.emissive = base.clone().multiplyScalar(0.14)
        m.material = mat
      })
      obj.position.y = -bb.min.y * s
      // local headgear — one accessory per city so the crowd reads as local:
      // bowler hats (London), conical bamboo hats (Beijing), turbans (Mumbai),
      // caps (Harbor/Tokyo), beanies (New York), berets (Paris)
      const hg = arch.headgear ?? 'none'
      const headTop = bb.max.y - 0.04
      const accMat = (c: number, e = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, emissive: new THREE.Color(c).multiplyScalar(e), emissiveIntensity: e > 0 ? 0.5 : 0 })
      if (hg === 'bowler') {
        const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.2, 0.24, 10), accMat(0x23262e))
        hat.position.y = headTop + 0.1
        obj.add(hat)
        const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.04, 10), accMat(0x2c3038))
        brim.position.y = headTop + 0.02
        obj.add(brim)
      } else if (hg === 'cone') {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.55, 8), accMat(0xd9a05a))
        cone.position.y = headTop + 0.28
        obj.add(cone)
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.1, 8), accMat(0x9a2e24))
        band.position.y = headTop + 0.06
        obj.add(band)
      } else if (hg === 'turban') {
        const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.34, 10), accMat(new THREE.Color(arch.people[Math.floor(rand() * arch.people.length)]).getHex()))
        wrap.position.y = headTop + 0.14
        obj.add(wrap)
        const knot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 6), accMat(0xf08c3a))
        knot.position.y = headTop + 0.3
        obj.add(knot)
      } else if (hg === 'cap') {
        const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.16, 10), accMat(0x1f242e))
        dome.position.y = headTop + 0.08
        obj.add(dome)
        const brim = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.28), accMat(0x1f242e))
        brim.position.set(0.12, headTop + 0.03, 0)
        obj.add(brim)
      } else if (hg === 'beanie') {
        const beanie = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.26, 10), accMat(0x2f3a4a))
        beanie.position.y = headTop + 0.11
        obj.add(beanie)
        const pom = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), accMat(0xd84a4a))
        pom.position.y = headTop + 0.26
        obj.add(pom)
      } else if (hg === 'beret') {
        const beret = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.3, 0.1, 10), accMat(0x5a3a3a))
        beret.position.y = headTop + 0.08
        obj.add(beret)
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), accMat(0x3a2a2a))
        knob.position.y = headTop + 0.14
        obj.add(knob)
      }
      // local outfit — the body mesh beyond the head: overcoats (London),
      // red scarves (Beijing), dupatta sashes (Mumbai), school backpacks
      // (Tokyo), café aprons (Paris), hoodies (New York), crew jackets (Harbor)
      const gar = arch.garment ?? 'none'
      const gmat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 })
      if (gar === 'overcoat') {
        const coat = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.92, 0.52), gmat(0x2b2f38))
        coat.position.y = 1.02
        obj.add(coat)
        const collar = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.16, 0.52), gmat(0x1f232b))
        collar.position.y = 1.5
        obj.add(collar)
      } else if (gar === 'scarf') {
        const scarf = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.2, 0.48), gmat(0xcf2f2f))
        scarf.position.y = 1.52
        obj.add(scarf)
        const tail = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.5, 0.1), gmat(0xa82222))
        tail.position.set(0.1, 1.15, 0.2)
        obj.add(tail)
      } else if (gar === 'dupatta') {
        const kurta = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.9, 0.44), gmat(new THREE.Color(arch.people[Math.floor(rand() * arch.people.length)]).getHex()))
        kurta.position.y = 1.02
        obj.add(kurta)
        const sash = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.22, 0.5), gmat(0xd4a017))
        sash.position.y = 1.34
        obj.add(sash)
      } else if (gar === 'backpack') {
        const pack = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.56, 0.2), gmat(0x2f3a4a))
        pack.position.set(0, 1.08, -0.34)
        obj.add(pack)
        const collar = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.14, 0.5), gmat(0xf5f7fa))
        collar.position.y = 1.58
        obj.add(collar)
      } else if (gar === 'apron') {
        const apron = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.74, 0.14), gmat(0xf2efe8))
        apron.position.set(0, 1.0, 0.4)
        obj.add(apron)
        const collar = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.14, 0.5), gmat(0x2a2f3a))
        collar.position.y = 1.56
        obj.add(collar)
      } else if (gar === 'hoodie') {
        const hood = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.84, 0.48), gmat(0x4a5568))
        hood.position.y = 1.02
        obj.add(hood)
        const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.26, 0.14), gmat(0x3f4a5e))
        pouch.position.set(0, 0.88, 0.26)
        obj.add(pouch)
      } else if (gar === 'jacket') {
        const jacket = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.78, 0.46), gmat(0x22303e))
        jacket.position.y = 1.0
        obj.add(jacket)
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.1, 0.48), gmat(0x22d3ee))
        stripe.position.y = 1.32
        obj.add(stripe)
      }
      const mixer = new THREE.AnimationMixer(obj)
      const idleClip = clips.find((c) => /idle|stand/i.test(c.name)) ?? clips[0]
      const action = mixer.clipAction(idleClip)
      action.play()
      action.timeScale = 0.85 + rand() * 0.3
      const wrap = new THREE.Group()
      wrap.add(obj)
      // sidewalk spot — road edge, slightly outside the travel lane
      const laneIdx = Math.floor(rand() * (N + 1))
      const c = -HALF + ROAD / 2 + laneIdx * CELL
      const off = (rand() > 0.5 ? 1 : -1) * (ROAD / 2 + 1.2)
      const axis = rand() > 0.5 ? 'x' : 'z'
      const along = (rand() * 2 - 1) * (HALF - 12)
      wrap.position.set(axis === 'x' ? along : c + off, 0, axis === 'x' ? c + off : along)
      wrap.rotation.y = rand() * Math.PI * 2
      parent.add(wrap)
      wraps.push(wrap)
      this.idlers.push({ mesh: wrap, mixer, baseY: 0 })
    }
    this.zoneCityPeds.set(zone.id, wraps)
  }

  /** Per-city sidewalk furniture — the last 5% that makes a street feel like
      a specific real city. Visual-only (no colliders), placed along the
      central avenues so they're in view while you drive. */
  private buildZoneFurniture(zone: WorldZone, parent: THREE.Group): void {
    const kind = zone.arch?.furniture ?? 'none'
    if (kind === 'none') return
    const rand = seededRand(8800 + (zone.arch?.winOffset ?? 0))
    // Geometry + materials per furniture type
    let body: THREE.BufferGeometry | null = null
    let bodyMat: THREE.MeshStandardMaterial
    let extra: THREE.BufferGeometry | null = null
    let extraMat: THREE.MeshStandardMaterial | null = null
    let glowMat: THREE.MeshBasicMaterial | null = null
    const bw = 0.9
    let bh = 2.1
    const bd = 0.9
    if (kind === 'booth') {
      bodyMat = new THREE.MeshStandardMaterial({ color: 0xd43636, roughness: 0.5, metalness: 0.3 })
      body = new THREE.BoxGeometry(bw, bh, bd)
      extraMat = new THREE.MeshStandardMaterial({ color: 0x2a1515, roughness: 0.6 })
      extra = new THREE.BoxGeometry(bw + 0.12, 0.22, bd + 0.12)
      glowMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 })
    } else if (kind === 'phonebox') {
      // London's red telephone box — iconic, unmistakable on a British street
      bodyMat = new THREE.MeshStandardMaterial({ color: 0xd43b2a, roughness: 0.45, metalness: 0.25 })
      body = new THREE.BoxGeometry(1.0, 2.4, 1.0)
      extraMat = new THREE.MeshStandardMaterial({ color: 0x3a1a10, roughness: 0.6 })
      extra = new THREE.BoxGeometry(1.14, 0.34, 1.14)
      glowMat = new THREE.MeshBasicMaterial({ color: 0xffe9b0 })
    } else if (kind === 'vending') {
      bodyMat = new THREE.MeshStandardMaterial({ color: 0x22303e, roughness: 0.6, metalness: 0.4 })
      body = new THREE.BoxGeometry(1.05, 2.0, 0.75)
      extraMat = null
      extra = null
      glowMat = new THREE.MeshBasicMaterial({ color: 0x8fd8ff })
    } else if (kind === 'stall') {
      bodyMat = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.8 })
      body = new THREE.BoxGeometry(2.2, 0.55, 1.5)
      extraMat = new THREE.MeshStandardMaterial({ color: 0x3f7a6e, roughness: 0.7 })
      extra = new THREE.BoxGeometry(2.3, 0.14, 1.6)
      glowMat = new THREE.MeshBasicMaterial({ color: 0xffe9b0 })
    } else if (kind === 'awning') {
      bodyMat = new THREE.MeshStandardMaterial({ color: 0x2b2b33, roughness: 0.7 })
      body = new THREE.BoxGeometry(2.8, 0.5, 1.7)
      extraMat = new THREE.MeshStandardMaterial({ color: 0xd9c9a0, roughness: 0.8 })
      extra = new THREE.BoxGeometry(2.8, 0.3, 1.7)
      glowMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 })
    } else if (kind === 'lantern') {
      bodyMat = new THREE.MeshStandardMaterial({ color: 0x3a2a16, roughness: 0.8 })
      body = new THREE.CylinderGeometry(0.07, 0.09, 2.5, 6)
      glowMat = new THREE.MeshBasicMaterial({ color: 0xff5340 })
      extraMat = null
      extra = null
    } else if (kind === 'steam') {
      bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a505a, roughness: 0.9 })
      body = new THREE.CylinderGeometry(0.55, 0.65, 0.22, 10)
      extraMat = null
      extra = null
      glowMat = new THREE.MeshBasicMaterial({ color: 0xdfe8f2, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false })
    } else {
      return
    }
    // Walk the central avenues (lanes 3..6), one prop every ~13m on a side
    for (let lane = 3; lane <= 6; lane++) {
      const c = -HALF + ROAD / 2 + lane * CELL
      const off = (lane % 2 === 0 ? 1 : -1) * (ROAD / 2 + 1.9)
      for (let a = -HALF + 18; a < HALF - 14; a += 13 + rand() * 4) {
        if (rand() < 0.18) continue // keep it natural, not a wall of props
        const along = a + (rand() - 0.5) * 5
        for (const axis of (['x', 'z'] as const)) {
          const x = axis === 'x' ? along : c + off
          const z = axis === 'x' ? c + off : along
          const g = new THREE.Group()
          if (body) {
            const b = new THREE.Mesh(body, bodyMat)
            if (kind === 'steam') b.position.y = 0.12
            else b.position.y = bh / 2
            g.add(b)
          }
          if (extra && extraMat) {
            const e = new THREE.Mesh(extra, extraMat)
            if (kind === 'stall') e.position.y = 0.75
            else if (kind === 'awning') e.position.y = 0.42
            else e.position.y = bh + 0.12
            g.add(e)
          }
          if (glowMat) {
            const lm = new THREE.Mesh(new THREE.SphereGeometry(0.24, 6, 6), glowMat)
            if (kind === 'booth') lm.position.y = 1.95
            else if (kind === 'vending') { lm.scale.set(0.12, 0.62, 0.08); lm.position.set(0, 1.0, 0.4) }
            else if (kind === 'stall') lm.position.set(0, 1.4, 0)
            else if (kind === 'awning') lm.position.set(0, 0.9, 0)
            else if (kind === 'lantern') lm.position.y = 2.45
            else if (kind === 'steam') { lm.scale.set(1.15, 1.4, 1.15); lm.position.y = 1.4 }
            g.add(lm)
          }
          g.position.set(x, 0, z)
          g.rotation.y = axis === 'x' ? Math.PI / 2 : 0
          g.rotation.y += (rand() - 0.5) * 0.2
          parent.add(g)
        }
      }
    }
  }

  /** Street-level litter that makes a map feel lived-in (the COD look):
      utility poles with sagging wires along every avenue + crates, barrels
      and sandbags at the block corners. Runs for every city. */
  private buildZoneStreetlife(zone: WorldZone, parent: THREE.Group): void {
    const rand = seededRand(4400 + (zone.arch?.winOffset ?? 0))
    // Each city hangs its own lamps: London's black cast-iron, Paris's green
    // art-nouveau, Beijing's red lantern posts, Tokyo's slate, Mumbai's warm
    // teak, New York's steel, Harbor's harbour teal.
    const lampCfg: Record<string, { pole: number; arm: number; glow: number }> = {
      harbor:  { pole: 0x22303a, arm: 0x2e4150, glow: 0x22d3ee },
      london:  { pole: 0x1e1e24, arm: 0x2a2a30, glow: 0xffce8a },
      paris:   { pole: 0x2f4a32, arm: 0x3f5a3f, glow: 0xbff0c8 },
      beijing: { pole: 0x5a1717, arm: 0x8a2020, glow: 0xffd9a0 },
      mumbai:  { pole: 0x5a4030, arm: 0x6b4a3a, glow: 0xffce8a },
      tokyo:   { pole: 0x35353f, arm: 0x4a4a55, glow: 0xffc2e0 },
      newyork: { pole: 0x4a4e56, arm: 0x55585e, glow: 0xf5f7fa },
    }
    const lamp = lampCfg[zone.id] ?? lampCfg.harbor
    const poleGeom = new THREE.CylinderGeometry(0.1, 0.18, 6.4, 6)
    const poleMat = new THREE.MeshStandardMaterial({ color: lamp.pole, roughness: 0.85, metalness: 0.15 })
    const armGeom = new THREE.BoxGeometry(1.2, 0.14, 0.14)
    const armMat = new THREE.MeshStandardMaterial({ color: lamp.arm, roughness: 0.8 })
    const glowGeom = new THREE.SphereGeometry(0.24, 8, 6)
    const glowMat = new THREE.MeshBasicMaterial({ color: lamp.glow, fog: false })
    const wireMat = new THREE.LineBasicMaterial({ color: 0x1c2027, transparent: true, opacity: 0.85 })
    const crateGeom = new THREE.BoxGeometry(1.2, 1.1, 1.2)
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.9 })
    const barrelGeom = new THREE.CylinderGeometry(0.5, 0.55, 1.1, 10)
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.7, metalness: 0.25 })
    const sandGeom = new THREE.BoxGeometry(0.9, 0.45, 0.5)
    const sandMat = new THREE.MeshStandardMaterial({ color: 0x9a8a5a, roughness: 0.95 })
    const wireGeomCache = new Map<string, THREE.BufferGeometry>()
    for (let lane = 3; lane <= 6; lane++) {
      const c = -HALF + ROAD / 2 + lane * CELL
      const off = (lane % 2 === 0 ? 1 : -1) * (ROAD / 2 + 1.9)
      // utility poles every ~44m along the lane, both side orientations
      let prevX: THREE.Vector3 | null = null
      let prevZ: THREE.Vector3 | null = null
      for (let a = -HALF + 20; a < HALF - 16; a += 44) {
        if (rand() < 0.12) continue
        for (const axis of (['x', 'z'] as const)) {
          const x = axis === 'x' ? a : c + off
          const z = axis === 'x' ? c + off : a
          const pole = new THREE.Mesh(poleGeom, poleMat)
          pole.position.set(x, 3.2, z)
          parent.add(pole)
          const arm = new THREE.Mesh(armGeom, armMat)
          if (axis === 'x') arm.position.set(x, 6.2, z + (off > 0 ? 0.55 : -0.55))
          else arm.position.set(x + (off > 0 ? 0.55 : -0.55), 6.2, z)
          parent.add(arm)
          const lampGlow = new THREE.Mesh(glowGeom, glowMat)
          if (axis === 'x') lampGlow.position.set(x, 6.25, z + (off > 0 ? 1.0 : -1.0))
          else lampGlow.position.set(x + (off > 0 ? 1.0 : -1.0), 6.25, z)
          parent.add(lampGlow)
          const top = new THREE.Vector3(x, 6.5, z)
          const prevKey = axis === 'x' ? prevX : prevZ
          if (prevKey) {
            const mid = prevKey.clone().add(top).multiplyScalar(0.5)
            mid.y -= 0.7 // sag
            const pts = [prevKey, mid, top]
            const key = pts.map((v) => v.x.toFixed(1) + ',' + v.y.toFixed(1) + ',' + v.z.toFixed(1)).join('|')
            let geo = wireGeomCache.get(key)
            if (!geo) {
              geo = new THREE.BufferGeometry().setFromPoints(pts)
              wireGeomCache.set(key, geo)
            }
            const wire = new THREE.Line(geo, wireMat)
            parent.add(wire)
          }
          if (axis === 'x') prevX = top
          else prevZ = top
        }
      }
      // corner props — crates, barrels, sandbags on the sidewalk
      for (let a = -HALF + 8; a < HALF - 8; a += 26 + rand() * 10) {
        if (rand() < 0.45) continue
        const along = a + (rand() - 0.5) * 6
        for (const axis of (['x', 'z'] as const)) {
          if (rand() < 0.4) continue
          const x = axis === 'x' ? along : c + off + (rand() - 0.5) * 2.2
          const z = axis === 'x' ? c + off + (rand() - 0.5) * 2.2 : along
          const kind = rand()
          if (kind < 0.4) {
            const cr = new THREE.Mesh(crateGeom, crateMat)
            cr.position.set(x, 0.55, z)
            cr.rotation.y = (rand() - 0.5) * 1.2
            parent.add(cr)
          } else if (kind < 0.7) {
            const br = new THREE.Mesh(barrelGeom, barrelMat)
            br.position.set(x, 0.55, z)
            br.rotation.y = (rand() - 0.5) * 1.2
            parent.add(br)
          } else {
            const st = new THREE.Group()
            for (let s = 0; s < 3; s++) {
              const sb = new THREE.Mesh(sandGeom, sandMat)
              sb.position.set(x + (s - 1) * 0.3, 0.45 * s + 0.22, z)
              sb.rotation.y = (rand() - 0.5) * 0.8
              st.add(sb)
            }
            st.position.set(0, 0, 0)
            parent.add(st)
          }
        }
      }
    }
  }

  /** Per-city road identity — the surface details a driver actually passes:
      zebra crossings, tree medians, tram rails, speed bumps, hydrants,
      double-yellow edges, hazard chevrons. Painted lines alone didn't read;
      now the road carries its own furniture. */
  private buildZoneRoadStyle(zone: WorldZone, parent: THREE.Group): void {
    const zid = zone.id
    const r = seededRand(7700 + (zone.arch?.winOffset ?? 0))
    const laneC = (l: number) => -HALF + ROAD / 2 + l * CELL
    // Per-city tarmac: the surface itself is different — texture AND width.
    // London lays wet black, Paris cobbles, Beijing light concrete, Mumbai
    // dusty worn, Tokyo clean asphalt, NY grey + manholes, Harbor slabs.
    const tarmac: Record<string, { kind: string; w: number }> = {
      harbor: { kind: 'industrial', w: 18 },
      london: { kind: 'wet', w: 12 },
      paris: { kind: 'cobble', w: 13 },
      beijing: { kind: 'concrete', w: 17 },
      mumbai: { kind: 'dusty', w: 13 },
      tokyo: { kind: 'clean', w: 14 },
      newyork: { kind: 'grey', w: 15 },
    }
    const tm = tarmac[zid] ?? tarmac.harbor
    const asphaltTex = makeAsphaltTexture(tm.kind)
    const asphaltMat = new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.92, metalness: 0 })
    const asGeomH = new THREE.PlaneGeometry(SIZE + 6, tm.w)
    const asGeomV = new THREE.PlaneGeometry(tm.w, SIZE + 6)
    for (const l of [3, 4, 5, 6]) {
      const c = laneC(l)
      const ah = new THREE.Mesh(asGeomH, asphaltMat)
      ah.rotation.x = -Math.PI / 2
      ah.position.set(0, 0.015, c)
      parent.add(ah)
      const av = new THREE.Mesh(asGeomV, asphaltMat)
      av.rotation.x = -Math.PI / 2
      av.rotation.z = Math.PI / 2
      av.position.set(c, 0.015, 0)
      parent.add(av)
      // keep texture scale readable: ~9m per tile along the road
      if (asphaltMat.map) asphaltMat.map.repeat.set((SIZE + 6) / 9, tm.w / 9)
    }
    const strip = (mat: THREE.Material, off: number, wid: number, w = 340, y = 0.04) => {
      const hGeom = new THREE.BoxGeometry(w, 0.07, wid)
      const vGeom = new THREE.BoxGeometry(wid, 0.07, w)
      for (const l of [3, 4, 5, 6]) {
        const c = laneC(l)
        const h = new THREE.Mesh(hGeom, mat); h.position.set(0, y, c + off); parent.add(h)
        const v = new THREE.Mesh(vGeom, mat); v.position.set(c + off, y, 0); parent.add(v)
      }
    }
    const crosswalk = (col: number, every = 2) => {
      const cm = new THREE.MeshBasicMaterial({ color: col, fog: false })
      const bg = new THREE.BoxGeometry(2.6, 0.05, 0.85)
      for (let li = 3; li <= 6; li++) for (let lj = 3; lj <= 6; lj++) {
        if ((li + lj) % every !== 0) continue
        const c1 = laneC(li), c2 = laneC(lj)
        for (let b = -3; b <= 3; b++) {
          const bx = new THREE.Mesh(bg, cm); bx.position.set(c2 + b * 3.1, 0.045, c1); parent.add(bx)
          const bz = new THREE.Mesh(bg, cm); bz.position.set(c1, 0.045, c2 + b * 3.1); parent.add(bz)
        }
      }
    }
    if (zid === 'beijing') {
      // Grand-boulevard tree medians down the middle of every avenue, red kerbs
      const gm = new THREE.MeshBasicMaterial({ color: 0x2f6b3a, fog: false })
      strip(gm, 0, 2.3, 340, 0.025)
      const treeGeom = new THREE.ConeGeometry(1.6, 3.4, 7)
      const treeMat = new THREE.MeshStandardMaterial({ color: 0x3d7a42, roughness: 0.9 })
      for (const l of [3, 4, 5, 6]) {
        const c = laneC(l)
        for (let a = -HALF + 20; a < HALF - 16; a += 44) {
          if (r() < 0.25) continue
          for (const axis of (['x', 'z'] as const)) {
            const t = new THREE.Mesh(treeGeom, treeMat)
            if (axis === 'x') t.position.set(a, 1.7, c)
            else t.position.set(c, 1.7, a)
            parent.add(t)
          }
        }
      }
      // crisp white centre line on top of the median band
      strip(new THREE.MeshBasicMaterial({ color: 0xdfe4ea, fog: false }), 0, 0.35, 340, 0.05)
    } else if (zid === 'paris') {
      // Tram rails — twin steel tracks down every avenue (Paris trams)
      const railMat = new THREE.MeshBasicMaterial({ color: 0x6a7078, fog: false })
      strip(railMat, -0.75, 0.16)
      strip(railMat, 0.75, 0.16)
      crosswalk(0xdfe4ea, 3)
    } else if (zid === 'mumbai') {
      // Faded zebra crossings + speed bumps + dust patches — chaotic traffic feel
      crosswalk(0xcfd2d0, 2)
      const bumpMat = new THREE.MeshBasicMaterial({ color: 0x3a3a3a, fog: false })
      const dustMat = new THREE.MeshBasicMaterial({ color: 0x2a2418, fog: false })
      for (const l of [3, 4, 5, 6]) {
        const c = laneC(l)
        for (let a = -HALF + 40; a < HALF - 24; a += 176) {
          for (const axis of (['x', 'z'] as const)) {
            if (axis === 'x') {
              for (let b = 0; b < 3; b++) {
                const bp = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.12, 0.8), bumpMat)
                bp.position.set(a + b * 1.6 - 1.6, 0.06, c); parent.add(bp)
              }
            } else {
              for (let b = 0; b < 3; b++) {
                const bp = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.12, 4.2), bumpMat)
                bp.position.set(c, 0.06, a + b * 1.6 - 1.6); parent.add(bp)
              }
            }
            if (r() < 0.5) {
              const d = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, 0.1, 8), dustMat)
              if (axis === 'x') d.position.set(a + (r() - 0.5) * 8, 0.03, c + (r() - 0.5) * 6)
              else d.position.set(c + (r() - 0.5) * 6, 0.03, a + (r() - 0.5) * 8)
              parent.add(d)
            }
          }
        }
      }
    } else if (zid === 'london') {
      // Double-yellow edge lines + zebra crossings at the junctions
      strip(new THREE.MeshBasicMaterial({ color: 0xf5d020, fog: false }), ROAD / 2 - 0.75, 0.3)
      strip(new THREE.MeshBasicMaterial({ color: 0xf5d020, fog: false }), -(ROAD / 2 - 0.75), 0.3)
      crosswalk(0xdfe4ea, 2)
    } else if (zid === 'newyork') {
      // Zebra crossings + red fire hydrants on the corners
      crosswalk(0xe8ebee, 2)
      const hydGeom = new THREE.CylinderGeometry(0.28, 0.34, 1.0, 8)
      const hydMat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.6, metalness: 0.3 })
      for (let li = 3; li <= 6; li++) for (let lj = 3; lj <= 6; lj++) {
        if ((li + lj) % 2 !== 0 || r() < 0.5) continue
        const c1 = laneC(li), c2 = laneC(lj)
        const h = new THREE.Mesh(hydGeom, hydMat)
        h.position.set(c2 + (ROAD / 2 + 2.2) * (r() < 0.5 ? 1 : -1), 0.5, c1 + (ROAD / 2 + 2.2) * (r() < 0.5 ? 1 : -1))
        parent.add(h)
      }
    } else if (zid === 'tokyo') {
      // Wide white crosswalks + blue edge guides (already) — dense crossings
      crosswalk(0xf2f4f7, 1)
    } else if (zid === 'harbor') {
      // Hazard chevrons along the dock roads + cyan guide (already)
      const hzMat = new THREE.MeshBasicMaterial({ color: 0xf5c542, fog: false })
      const hzGeom = new THREE.BoxGeometry(7, 0.06, 0.9)
      for (const l of [3, 4, 5, 6]) {
        const c = laneC(l)
        for (let a = -HALF + 30; a < HALF - 20; a += 132) {
          const h1 = new THREE.Mesh(hzGeom, hzMat)
          h1.position.set(a, 0.045, c + ROAD / 2 - 1.2); h1.rotation.y = 0.7; parent.add(h1)
          const h2 = new THREE.Mesh(hzGeom, hzMat)
          h2.position.set(a + 6, 0.045, c - (ROAD / 2 - 1.2)); h2.rotation.y = -0.7; parent.add(h2)
          const v1 = new THREE.Mesh(hzGeom, hzMat)
          v1.position.set(c + ROAD / 2 - 1.2, 0.045, a); v1.rotation.y = 0.7; parent.add(v1)
          const v2 = new THREE.Mesh(hzGeom, hzMat)
          v2.position.set(c - (ROAD / 2 - 1.2), 0.045, a + 6); v2.rotation.y = -0.7; parent.add(v2)
        }
      }
    }
  }

  /** Build one landmark group per zone — placed just outside the city square
      (R = 236) ON the waterfront so it stands IN the view while you drive the
      outer ring, not a pixel lost in the far fog. Materials are fog:false so
      the hero silhouette punches through the night like the moon; a point
      light, glow ring and city signboard complete the "arrival" shot. */
  private buildZoneLandmarks(): void {
    const angFor = (i: number) => i * ((Math.PI * 2) / WORLD_ZONES.length) + 0.35
    const R = 236
    const place = (g: THREE.Group, i: number) => {
      const a = angFor(i)
      g.position.set(Math.cos(a) * R, 0, Math.sin(a) * R)
      g.rotation.y = -a + Math.PI
    }
    const mk = (id: string, build: (g: THREE.Group) => void): void => {
      const g = new THREE.Group()
      build(g)
      // Skyline heroes ignore fog — the moon and stars already do, so the
      // landmark stays crisp at every distance instead of dissolving. They
      // also self-glow: night hero icons read as silhouettes only if they
      // carry their own light, so every non-glowing part gets a faint
      // emissive of its own colour (explicit glow parts keep their glow).
      g.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh && m.material) {
          const mat = Array.isArray(m.material) ? m.material : [m.material]
          for (const mm of mat) {
            ;(mm as THREE.MeshStandardMaterial).fog = false
            const std = mm as THREE.MeshStandardMaterial
            if (std.emissive && std.emissive.getHex() === 0) {
              std.emissive.copy(std.color).multiplyScalar(0.26)
              std.emissiveIntensity = 1
            }
            std.roughness = 0.55
          }
        }
      })
      this.scene.add(g)
      g.visible = false
      this.zoneLandmarks.set(id, g)
    }
    const sig = (g: THREE.Group, w: number, h: number, d: number, x: number, y: number, z: number, c: number): void => {
      g.add(this.box(w, h, d, x, y, z, c))
    }

    // ---- Harbor — the Lighthouse (white tower, red bands, sweeping beam) ----
    mk('harbor', (g) => {
      sig(g, 2.4, 9, 2.4, 0, 0.2, 0, 0x3a4450) // base plinth
      g.add(this.box(8, 76, 8, 0, 38, 0, 0xdfe6ee))
      g.add(this.box(8.6, 3.6, 8.6, 0, 10, 0, 0xd94f3d))
      g.add(this.box(8.6, 3.6, 8.6, 0, 27, 0, 0xd94f3d))
      g.add(this.box(8.6, 3.6, 8.6, 0, 46, 0, 0xd94f3d))
      const lamp = this.box(6, 3.6, 6, 0, 82, 0, 0xffe9a8, 0xffd23d, 1.6)
      g.add(lamp)
      g.add(new THREE.Mesh(new THREE.ConeGeometry(6, 10, 4), new THREE.MeshStandardMaterial({ color: 0x23303c })))
      // guard shack + cones by the door
      sig(g, 3.4, 2.6, 3.4, 7, 1.3, -3, 0x1e2a36)
      sig(g, 0.7, 1.4, 0.7, 11, 0.7, -4.6, 0xff7a24)
      sig(g, 0.7, 1.4, 0.7, 12.6, 0.7, -3.2, 0xff7a24)
      const beam = this.box(1.6, 1.6, 26, 0, 90, 6, 0xfff6cc, 0xffe9a8, 1.5)
      beam.rotation.x = Math.PI / 2
      g.add(beam)
    })

    // ---- London — Big Ben + the Houses of Parliament + Tower Bridge ----
    // A full Westminster waterfront so the city reads instantly: the clock
    // tower, the long Gothic palace block with its rooftop turrets and the
    // Victoria Tower, then a Tower Bridge silhouetted along the Thames.
    mk('london', (g) => {
      sig(g, 3.4, 9, 3.4, 0, 0.2, 0, 0x3a4450)
      // Big Ben — clock tower + spire
      g.add(this.box(8, 66, 8, 0, 33, 0, 0xb9a27a))
      g.add(this.box(9.2, 14, 9.2, 0, 9, 0, 0x8a7450))
      g.add(this.box(6.6, 10, 6.6, 0, 73, 0, 0xc9b48a))
      const roof = new THREE.Mesh(new THREE.ConeGeometry(7, 11, 4), new THREE.MeshStandardMaterial({ color: 0x2f3540 }))
      roof.position.set(0, 68, 0)
      g.add(roof)
      const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.1, 16, 6), new THREE.MeshStandardMaterial({ color: 0xcfd6e0 }))
      spire.position.set(0, 82, 0)
      g.add(spire)
      // four glowing clock faces, twice as big
      for (const s of [-1, 1] as const) {
        g.add(this.box(0.3, 7, 7, 4.2, 62, s * 1.9, 0xffd9a0, 0xffd9a0, 1.5))
        g.add(this.box(7, 7, 0.3, s * 1.9, 62, 4.2, 0xffd9a0, 0xffd9a0, 1.5))
      }

      // Houses of Parliament — long Gothic block + Victoria Tower + turrets
      const stone = 0xc9b88d
      const winC = 0x202838
      g.add(this.box(34, 22, 9, 0, 11, -58, stone)) // main palace block
      g.add(this.box(36, 2.2, 9.4, 0, 23.2, -58, 0x3a3f4a)) // battlements band
      // Victoria Tower — tall square tower with a gilded crown at one end
      g.add(this.box(7.4, 36, 7.4, 0, 18, -44, 0xbfae7f))
      const victoriaCrown = new THREE.Mesh(new THREE.ConeGeometry(5, 9, 4), new THREE.MeshStandardMaterial({ color: 0xd8c891, emissive: 0x8a6a1e, emissiveIntensity: 0.5 }))
      victoriaCrown.position.set(0, 38, -44)
      g.add(victoriaCrown)
      // rooftop turrets + spires along the palace
      for (const [tx, tz] of [[-13, -58], [13, -58], [26, -58], [-26, -58]] as const) {
        const turret = new THREE.Mesh(new THREE.ConeGeometry(1.8, 6, 4), new THREE.MeshStandardMaterial({ color: 0x2f3540 }))
        turret.position.set(tx, 25.5, tz)
        g.add(turret)
        g.add(this.box(0.5, 3.4, 0.5, tx, 30, tz, 0xcfd6e0))
      }
      // gothic windows — two lit rows on the riverside face
      for (const [wx, wy] of [[-24, 8], [-17, 8], [-10, 8], [-3, 8], [4, 8], [11, 8], [18, 8], [25, 8], [-24, 16], [-17, 16], [-10, 16], [-3, 16], [4, 16], [11, 16], [18, 16], [25, 16]] as const) {
        g.add(this.box(1.6, 3.4, 0.3, wx, wy, -53.6, winC, 0x9a8a52, 0.55))
      }
      // riverside lanterns along the palace
      for (const lx of [-18, -8, 2, 12, 22] as const) {
        g.add(this.box(0.4, 4, 0.4, lx, 3, -52, 0x23262e))
        g.add(this.box(1, 1, 1, lx, 5.6, -52, 0xffe9b0, 0xffd9a0, 1.3))
      }

      // Tower Bridge — twin towers, deck, upper walkway, cables
      const towerAt = (tz: number) => {
        g.add(this.box(7.4, 28, 7.4, 0, 14, tz, 0xc9b88d))
        const towerRoof = new THREE.Mesh(new THREE.ConeGeometry(5.4, 9, 4), new THREE.MeshStandardMaterial({ color: 0xb03a3a, emissive: 0x5e1d1d, emissiveIntensity: 0.35 }))
        towerRoof.position.set(0, 31, tz)
        g.add(towerRoof)
        const towerSpire = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 3.6, 6), new THREE.MeshStandardMaterial({ color: 0xcfd6e0 }))
        towerSpire.position.set(0, 36.5, tz)
        g.add(towerSpire)
        g.add(this.box(1.8, 2, 1.8, 0, 19, tz, 0xffe9b0, 0xffd9a0, 1.2)) // lamp
      }
      towerAt(66)
      towerAt(106)
      g.add(this.box(42, 2.4, 8, 0, 8, 86, 0x3a3f4a)) // deck
      g.add(this.box(42, 2.2, 5, 0, 21, 86, 0x3a6ea8, 0x2f6bb0, 0.8)) // upper walkway
      // suspension cables — from each tower top sloping to the bank
      for (const tz of [66, 106] as const) {
        for (const side of [-1, 1] as const) {
          const cable = this.box(0.8, 0.8, 26, 0, 21 + side * 0.4, tz + side * 13, 0xd8d2c4, 0x9a8a52, 0.35)
          cable.rotation.x = side * -0.55
          g.add(cable)
        }
      }
      // riverside lamps on the bridge deck
      for (const lz of [74, 86, 98] as const) {
        g.add(this.box(0.4, 2.6, 0.4, -8, 10.4, lz, 0x23262e))
        g.add(this.box(0.9, 0.9, 0.9, -8, 12, lz, 0xffe9b0, 0xffd9a0, 1.2))
        g.add(this.box(0.4, 2.6, 0.4, 8, 10.4, lz, 0x23262e))
        g.add(this.box(0.9, 0.9, 0.9, 8, 12, lz, 0xffe9b0, 0xffd9a0, 1.2))
      }

      // black cab + red double-decker parked by the riverside
      sig(g, 2.4, 1.6, 4.6, -11, 0.8, 7, 0x14161c)
      sig(g, 2.2, 1.1, 4.2, -11, 1.7, 7, 0x2c3038)
      sig(g, 2.8, 2.6, 8.2, 12, 1.3, 6, 0xc0392b)
      sig(g, 2.7, 1.2, 7.6, 12, 2.9, 6, 0xe3f2fb)
      sig(g, 0.24, 1.2, 7.8, 12, 2.6, 6, 0x0e1116)

      // Tower of London — the castle by the Thames: white keep, four turret
      // towers with onion domes, crenellated walls, a flag and a raven perch
      g.add(this.box(16, 24, 14, -78, 12, 20, 0xdfe2e8)) // white keep
      for (const [tx, tz] of [[-70, 13], [-86, 13], [-70, 27], [-86, 27]] as const) {
        const turret = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 12, 8), new THREE.MeshStandardMaterial({ color: 0xd8dbe0 }))
        turret.position.set(tx, 6, tz)
        g.add(turret)
        const dome = new THREE.Mesh(new THREE.SphereGeometry(2.6, 8, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3f7a6e }))
        dome.position.set(tx, 13.2, tz)
        g.add(dome)
        const spike = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.8, 6), new THREE.MeshStandardMaterial({ color: 0xd8c891 }))
        spike.position.set(tx, 14.8, tz)
        g.add(spike)
      }
      for (const [bx, bz] of [[-78, 12], [-78, 28], [-66, 20], [-90, 20]] as const) {
        g.add(this.box(2.4, 1.4, 2.4, bx, 25.6, bz, 0x8a93a6)) // battlements
      }
      g.add(this.box(1.2, 9, 1.2, -66, 30, 20, 0x23262e)) // flag mast
      g.add(this.box(2.2, 2.2, 0.4, -66, 36, 20, 0xd84a4a, 0xd84a4a, 0.8)) // flag
      sig(g, 0.6, 0.8, 0.6, -88, 0.4, 16, 0x14161c) // ravens
      sig(g, 0.6, 0.8, 0.6, -89, 0.4, 14, 0x14161c)
      sig(g, 1.0, 2.4, 1.0, -92, 1.2, 20, 0xd43b2a) // red phone box by the gate
      sig(g, 1.14, 0.34, 1.14, -92, 2.7, 20, 0x3a1a10)
    })

    // ---- Paris — Eiffel Tower (tapered stack, beacon tip, café lights) ----
    mk('paris', (g) => {
      sig(g, 3.4, 9, 3.4, 0, 0.2, 0, 0x3a4450)
      const tier = (w: number, h: number, y: number, c: number) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 }))
        m.position.set(0, y, 0)
        g.add(m)
      }
      tier(22, 38, 19, 0x6b5544)
      tier(15, 30, 53, 0x5e4a3c)
      tier(9, 20, 78, 0x514037)
      const deck = this.box(22.4, 2.4, 22.4, 0, 38, 0, 0x4a3c30)
      g.add(deck)
      const deck2 = this.box(15.4, 1.8, 15.4, 0, 68, 0, 0x45382d)
      g.add(deck2)
      const tip = this.box(1.6, 9, 1.6, 0, 92, 0, 0xffcf70, 0xffcf70, 1.6)
      g.add(tip)
      // café awning + glowing bistro lights at the base
      sig(g, 1.2, 0.9, 11, -12, 3.2, 3, 0xd9b98a)
      for (const bx of [-9, -3, 3, 9]) g.add(this.box(0.5, 0.5, 0.5, bx, 3.8, 8, 0xffe9b0, 0xffd9a0, 1.4))

      // Arc de Triomphe — the Champs-Élysées arch: two legs, one entablature,
      // a warm eternal-flame glow under the span, off to the east
      g.add(this.box(6, 14, 6, -13, 7, 14, 0x9a8a6a))
      g.add(this.box(6, 14, 6, 13, 7, 14, 0x9a8a6a))
      g.add(this.box(34, 4.2, 6, 0, 14.6, 14, 0xb8a888))
      g.add(this.box(36, 1.6, 6.4, 0, 17.4, 14, 0x8a7a5a))
      for (const [px, pz] of [[-13, 12.4], [13, 12.4]] as const) {
        g.add(this.box(6.8, 3.4, 1.4, px, 6.8, pz, 0xc9b88d))
        g.add(this.box(6.8, 3.4, 1.4, px, 6.8, 15.6, 0xc9b88d))
      }
      g.add(this.box(0.6, 2.4, 0.6, 0, 1.2, 14, 0xffe9b0, 0xffd9a0, 1.6)) // flame
    })

    // ---- Beijing — Golden Pagoda (five tiers, upturned gold roofs) ----
    mk('beijing', (g) => {
      sig(g, 3.4, 9, 3.4, 0, 0.2, 0, 0x3a4450)
      const tiers: [number, number, number][] = [[21, 11, 7], [18, 11, 22], [16, 11, 37], [13, 11, 52], [10, 11, 66]]
      for (const [w, h, y] of tiers) {
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), new THREE.MeshStandardMaterial({ color: 0x9a2e24 }))
        body.position.set(0, y, 0)
        g.add(body)
        const roof = new THREE.Mesh(new THREE.ConeGeometry(w * 0.8, 5, 8), new THREE.MeshStandardMaterial({ color: 0xcfb457, emissive: 0x8a6a1e, emissiveIntensity: 0.35 }))
        roof.position.set(0, y + h / 2 + 2.5, 0)
        g.add(roof)
      }
      const finial = this.box(2, 9, 2, 0, 80, 0, 0xffd23d, 0xffd23d, 1.5)
      g.add(finial)
      // lantern posts flanking the gate
      for (const s of [-1, 1] as const) {
        g.add(this.box(0.5, 6, 0.5, s * 9, 3, -2, 0x2b2f3a))
        g.add(this.box(1.6, 1.6, 1.6, s * 9, 6.6, -2, 0xff6a3d, 0xff4d2e, 1.6))
        g.add(this.box(1.6, 1.6, 1.6, s * 9, 6.6, 2, 0xff6a3d, 0xff4d2e, 1.6))
      }

      // Bird's Nest — the Olympic stadium: interlaced steel rings glowing
      // over a red-lit bowl, unmistakably Beijing 2008
      const nestSteel = new THREE.MeshStandardMaterial({ color: 0xb8c0cc, roughness: 0.4, metalness: 0.6 })
      const nest = new THREE.Group()
      const nestSegs = 14
      for (let i = 0; i < nestSegs; i++) {
        const a = (i / nestSegs) * Math.PI * 2
        const cx = Math.cos(a) * 22
        const cz = Math.sin(a) * 15
        for (const k of [0, 1] as const) {
          const b = new THREE.Mesh(new THREE.BoxGeometry(1.6, 7 + k * 6, 1.6), nestSteel)
          b.position.set(cx, 4 + k * 4, cz)
          b.rotation.y = a + Math.PI / 2
          nest.add(b)
        }
      }
      // bowl + rim glow + outer red wall
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(14, 10, 5, 12), new THREE.MeshBasicMaterial({ color: 0xff4d2e, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }))
      bowl.position.y = 1.6
      nest.add(bowl)
      nest.position.set(-52, 0, 34)
      g.add(nest)
      for (const [mx, mz] of [[-74, 34], [-30, 34], [-52, 12], [-52, 56]] as const) {
        sig(g, 1.4, 3.2, 1.4, mx, 1.6, mz, 0xb8c0cc)
        g.add(this.box(2.2, 2.2, 2.2, mx, 3.6, mz, 0xff5340, 0xff4d2e, 1.5))
      }

      // Guomao — the CBD's twin glass towers, dark glass with lit seam strips
      for (const sx of [-36, -26] as const) {
        g.add(this.box(9, 74, 9, sx, 37, -52, 0x232e42))
        g.add(this.box(9.6, 2.6, 9.6, sx, 62, -52, 0x8fd8ff, 0x8fd8ff, 0.8))
        g.add(this.box(7, 14, 7, sx, 91, -52, 0x232e42))
        const gSpire = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.6, 10, 6), new THREE.MeshStandardMaterial({ color: 0xcfd6e0, emissive: 0x8fd8ff, emissiveIntensity: 0.6 }))
        gSpire.position.set(sx, 102, -52)
        g.add(gSpire)
        for (const wy of [6, 16, 26, 36, 46, 56] as const) {
          g.add(this.box(0.5, 0.7, 9.4, sx, wy, -52, 0x8fd8ff, 0x8fd8ff, 0.5))
          g.add(this.box(0.5, 0.7, 9.4, sx + 4.4, wy, -52, 0x8fd8ff, 0x8fd8ff, 0.5))
        }
      }
    })

    // ---- Mumbai — Gateway of India (arch on the waterfront) + tuk-tuks ----
    mk('mumbai', (g) => {
      sig(g, 3.4, 9, 3.4, 0, 0.2, 0, 0x3a4450)
      g.add(this.box(5, 28, 5, -9, 14, 0, 0xb98e5f))
      g.add(this.box(5, 28, 5, 9, 14, 0, 0xb98e5f))
      g.add(this.box(32, 6, 8, 0, 30, 0, 0xc49a68))
      g.add(this.box(16, 3.4, 5.4, 0, 36, 0, 0x8a6a44))
      const dome = new THREE.Mesh(new THREE.SphereGeometry(4.4, 8, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xc49a68 }))
      dome.position.set(0, 38, 0)
      g.add(dome)
      g.add(this.box(24, 0.6, 6.6, 0, 28, 0, 0xffd9a0, 0xffd9a0, 0.9))
      // tuk-tuks — saffron, green and blue auto-rickshaws
      for (const [tx, tz, tc] of [[-13, 6, 0xf08c3a], [13, 7, 0x3aa855], [0, 10, 0x2f8fd8]] as const) {
        sig(g, 2, 1.5, 2.8, tx, 0.75, tz, tc)
        sig(g, 1.8, 0.6, 2.6, tx, 1.9, tz, 0xf5f7fa)
      }

      // Chhatrapati Shivaji Terminus — the Victorian railway cathedral:
      // central gothic clock tower, onion dome, flanking wings + turrets
      g.add(this.box(20, 26, 12, -58, 13, 8, 0x9a8a6a)) // main station block
      for (const [wx, wz] of [[-68, 2], [-48, 2], [-68, 14], [-48, 14]] as const) {
        const turret = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.9, 14, 8), new THREE.MeshStandardMaterial({ color: 0xb8a888 }))
        turret.position.set(wx, 7, wz)
        g.add(turret)
        const tdome = new THREE.Mesh(new THREE.SphereGeometry(1.8, 8, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x7b6a4a }))
        tdome.position.set(wx, 15.6, wz)
        g.add(tdome)
      }
      g.add(this.box(5.6, 30, 5.6, -58, 15, -2, 0xc9b88d)) // clock tower
      g.add(this.box(3.6, 8, 3.6, -58, 34, -2, 0x8a7a5a))
      const bigDome = new THREE.Mesh(new THREE.SphereGeometry(4, 8, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8f7f5f }))
      bigDome.position.set(-58, 40, -2)
      g.add(bigDome)
      const cSpike = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3, 6), new THREE.MeshStandardMaterial({ color: 0xd8c891 }))
      cSpike.position.set(-58, 43, -2)
      g.add(cSpike)
      // glowing clock face + gothic windows
      g.add(this.box(0.4, 5, 5, -58, 30, 0.4, 0xffd9a0, 0xffd9a0, 1.3))
      for (const [wx, wy] of [[-66, 10], [-62, 10], [-54, 10], [-50, 10], [-66, 18], [-54, 18]] as const) {
        g.add(this.box(1.4, 2.8, 0.3, wx, wy, 2.4, 0x202838, 0x9a8a52, 0.55))
      }
      // BEST red double-decker at the station forecourt + a Bollywood board
      sig(g, 2.8, 2.6, 8.2, -40, 1.3, 8, 0xc0392b)
      sig(g, 2.7, 1.2, 7.6, -40, 2.9, 8, 0xe3f2fb)
      sig(g, 0.24, 1.2, 7.8, -40, 2.6, 8, 0x0e1116)
      const bTex = makeSignTexture('BOLLYWOOD', '#ff6aa7')
      const bMat = new THREE.MeshBasicMaterial({ map: bTex, transparent: true, fog: false, depthWrite: false, side: THREE.DoubleSide })
      const bBoard = new THREE.Mesh(new THREE.PlaneGeometry(14, 6), bMat)
      bBoard.position.set(-70, 34, -6)
      bBoard.lookAt(0, 30, 0)
      g.add(bBoard)
    })

    // ---- Tokyo — Tokyo Tower (red tapered tower, white orb, antenna) ----
    mk('tokyo', (g) => {
      sig(g, 3.4, 9, 3.4, 0, 0.2, 0, 0x3a4450)
      const lower = new THREE.Mesh(new THREE.BoxGeometry(18, 52, 18), new THREE.MeshStandardMaterial({ color: 0xd84a4a }))
      lower.position.set(0, 26, 0)
      g.add(lower)
      const upper = new THREE.Mesh(new THREE.BoxGeometry(10, 36, 10), new THREE.MeshStandardMaterial({ color: 0xe05a5a }))
      upper.position.set(0, 70, 0)
      g.add(upper)
      const orb = new THREE.Mesh(new THREE.SphereGeometry(5, 10, 10), new THREE.MeshStandardMaterial({ color: 0xf0f4fa, emissive: 0xfff3d6, emissiveIntensity: 1.2 }))
      orb.position.set(0, 95, 0)
      g.add(orb)
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.4, 18, 6), new THREE.MeshStandardMaterial({ color: 0xe05a5a }))
      ant.position.set(0, 111, 0)
      g.add(ant)
      const beac = this.box(1.8, 3.4, 1.8, 0, 122, 0, 0xff6aa7, 0xff6aa7, 2)
      g.add(beac)
      // torii gate + white taxi at the base — double lintel with a vermilion
      // glow, the way the real Meiji-era gates read at night
      sig(g, 1.6, 10.5, 1.6, -6, 5.25, 8, 0xd84a4a)
      sig(g, 1.6, 10.5, 1.6, 6, 5.25, 8, 0xd84a4a)
      g.add(this.box(14, 1.6, 1.6, 0, 9.4, 8, 0xd84a4a, 0x7a1f1f, 0.5))
      g.add(this.box(16, 2.6, 2.6, 0, 11.6, 8, 0xe86a5a, 0xe86a5a, 0.55))
      g.add(this.box(2.2, 2.2, 0.5, 0, 8.4, 8, 0xffd9a0, 0xffd9a0, 1.2)) // gate board glow
      // Shibuya-style giant screen + zebra crossing on the plaza
      const shTex = makeSignTexture('SHIBUYA', '#22d3ee')
      const shMat = new THREE.MeshBasicMaterial({ map: shTex, transparent: true, fog: false, depthWrite: false, side: THREE.DoubleSide })
      const shBoard = new THREE.Mesh(new THREE.PlaneGeometry(12, 6), shMat)
      shBoard.position.set(-24, 8, -10)
      shBoard.lookAt(0, 6, 0)
      g.add(shBoard)
      for (const zz of [11, 13.4, 15.8, 18.2]) {
        for (const xx of [-5, -2, 1, 4]) {
          g.add(this.box(1.8, 0.06, 1.1, xx, 0.03, zz, 0xe8e8f0))
        }
      }
      sig(g, 2.6, 1.8, 5, -12, 0.9, -6, 0xeef2f6)
      sig(g, 2.4, 1.2, 4.6, -12, 2.1, -6, 0x9fb2c4)
    })

    // ---- New York — Empire State (stepped tower + spire) and the Lady ----
    mk('newyork', (g) => {
      sig(g, 3.4, 9, 3.4, 0, 0.2, 0, 0x3a4450)
      g.add(this.box(22, 40, 22, 0, 20, 0, 0x3c4354))
      g.add(this.box(16, 28, 16, 0, 54, 0, 0x464e60))
      g.add(this.box(11, 22, 11, 0, 79, 0, 0x525b70))
      const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.5, 20, 6), new THREE.MeshStandardMaterial({ color: 0xcfd6e0 }))
      spire.position.set(0, 100, 0)
      g.add(spire)
      g.add(this.box(12, 1.2, 12, 0, 68, 0, 0x6ea8ff, 0x6ea8ff, 1.2))
      g.add(this.box(12, 1.2, 12, 0, 90, 0, 0xffd23d, 0xffd23d, 1.2))
      // Statue of Liberty silhouette — pedestal, robe, torch beam
      g.add(this.box(12, 8, 12, 34, 5, -8, 0x47505e))
      g.add(this.box(6, 17, 6, 34, 17, -8, 0x5a6475))
      g.add(this.box(3.4, 9, 3.4, 35.6, 29, -8, 0x6b7688))
      g.add(this.box(1.4, 8, 1.4, 37.4, 36, -8, 0x8b96a8))
      const torch = this.box(2, 2, 2, 38.8, 41, -8, 0xffd23d, 0xffd23d, 2.2)
      g.add(torch)
      const beam2 = this.box(1.6, 1.6, 18, 38.8, 42, -16, 0xfff2cc, 0xffd9a0, 1.6)
      beam2.rotation.x = Math.PI / 2
      g.add(beam2)
      // yellow cab at the curb
      sig(g, 2.6, 1.7, 5, -13, 0.85, 8, 0xf5a623)
      sig(g, 2.4, 1.1, 4.6, -13, 2.1, 8, 0xd8e6f2)
      // Times Square — a billboard wall of glowing ad panels + neon strips,
      // the one thing that says "New York" louder than any tower
      const tsWall = new THREE.Group()
      const panelColors = [0xff4d6d, 0x22d3ee, 0xfde047, 0xa78bfa, 0x4ade80, 0xffa94d]
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 3; c++) {
          const col = panelColors[(r * 3 + c) % panelColors.length]
          const panel = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 3.2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.92, fog: false, side: THREE.DoubleSide }))
          panel.position.set(-12 + c * 4.6, 5 + r * 3.6, 0)
          tsWall.add(panel)
        }
      }
      for (const nx of [-14.6, -1, 12.6]) {
        g.add(this.box(0.5, 17.5, 0.5, nx, 12, 18, 0xfff2cc, 0xffd9a0, 0.9)) // neon edge strips
      }
      const tsTex = makeSignTexture('TIMES SQ', '#ffe14d')
      const tsMat = new THREE.MeshBasicMaterial({ map: tsTex, transparent: true, fog: false, depthWrite: false, side: THREE.DoubleSide })
      const tsBoard = new THREE.Mesh(new THREE.PlaneGeometry(14, 5), tsMat)
      tsBoard.position.set(-1, 18.5, 0.6)
      tsWall.add(tsBoard)
      tsWall.position.set(34, 0, 18)
      tsWall.rotation.y = 0.5
      g.add(tsWall)
    })

    // city-name signboard — separate scene child so it always faces the city
    WORLD_ZONES.forEach((z, i) => {
      const a = angFor(i)
      const x = Math.cos(a) * R
      const zz = Math.sin(a) * R
      const tex = makeSignTexture(`${z.name.toUpperCase()} · ${z.landmark.toUpperCase()}`, `#${z.trim.toString(16).padStart(6, '0')}`)
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false, depthWrite: false, side: THREE.DoubleSide })
      const board = new THREE.Mesh(new THREE.PlaneGeometry(30, 15), mat)
      board.position.set(x, 58, zz)
      board.lookAt(0, 58, 0)
      board.visible = false
      this.scene.add(board)
      this.zoneSigns.set(z.id, board)
      // glow light — city-coloured wash around the landmark (the game's light
      // convention: intensity ~60-90 for a scene beacon)
      const light = new THREE.PointLight(z.trim, 90, 260, 1.6)
      light.position.set(x, 40, zz)
      light.visible = false
      this.scene.add(light)
      this.zoneLandmarkLights.set(z.id, light)
    })

    for (const [id, g] of this.zoneLandmarks) place(g, WORLD_ZONES.findIndex((z) => z.id === id))
  }

  /** Every frame: roll the odometer forward. Every ZONE_LENGTH_KM the world
      becomes the next city — banner, skyline, architecture mood, window glow. */
  private updateWorldCircuit(dt: number): void {
    if (this.wrecked || this.attract || this.busted) return
    const save = this.hooks.getSave()
    const kmh = this.vel.length() * 3.6
    if (kmh > 0.5) this.worldKm += (kmh * dt) / 3600
    const st = zoneAt(this.worldKm)
    if (st.zone.id !== this.lastZoneId) {
      this.lastZoneId = st.zone.id
      this.applyZoneMood(st.zone, true)
      this.synth.setZoneMusic(st.zone.id)
      this.zoneCamT = 2.3 // arrival reveal — camera lifts toward the landmark
      save.worldKm = this.worldKm
      save.laps = st.lap
      if (!save.zonesSeen.includes(st.zone.id)) {
        save.zonesSeen.push(st.zone.id)
        const unlocked = save.level >= st.zone.unlockLevel
        if (unlocked) {
          save.cash += 150
          this.hooks.onToast(`🌍 ${st.zone.name.toUpperCase()} — ${st.zone.tag} (+$150 arrival bonus)`, 'good')
        } else {
          this.hooks.onToast(`🔒 ${st.zone.name.toUpperCase()} — claim it at Level ${st.zone.unlockLevel}. Driving through is free.`, 'info')
        }
      }
      this.hooks.commit()
      this.hooks.onZoneEntered?.(st.zone.id)
    } else if (this.worldKm - save.worldKm >= 0.25) {
      save.worldKm = this.worldKm
      save.laps = st.lap
      this.hooks.commit()
    }
  }

  /** Re-tint the whole city to the zone's identity: building mood, window
      warmth, skyline facade and the hero landmark silhouette. */
  private applyZoneMood(zone: WorldZone, banner: boolean): void {
    // 1) Architecture pack — every city owns its own roofs/windows/neon/people
    for (const [id, g] of this.zoneCities) {
      g.visible = id === zone.id
      if (id === zone.id) {
        const wm = this.zoneWinMats.get(id)
        if (wm) this.scene.userData.winMat = wm
      }
    }
    // 2) Street crowd wardrobe — re-tint shirts toward this city's look
    const arch = zone.arch
    const accent = new THREE.Color()
    if (arch) {
      const cols = arch.people.map((c) => new THREE.Color(c))
      this.peds.forEach((pd, i) => {
        if (!pd.shirtMats?.length || !pd.baseShirt) return
        accent.copy(cols[i % cols.length])
        for (const m of pd.shirtMats) {
          m.color.copy(pd.baseShirt.clone().lerp(accent, 0.55))
        }
      })
    }
    // 3) Distant skyline facade — zone horizon tint
    const skyMat = this.scene.userData.skylineMat as THREE.MeshStandardMaterial | undefined
    if (skyMat) {
      skyMat.color.set(zone.facade)
      skyMat.emissive.set(zone.facade)
      skyMat.emissiveIntensity = 0.62
    }
    // 4) Hero landmark — one city at a time, with its glow light + signboard
    for (const [id, g] of this.zoneLandmarks) {
      g.visible = id === zone.id
      this.zoneLandmarkLights.get(id)!.visible = id === zone.id
      this.zoneSigns.get(id)!.visible = id === zone.id
      if (id === zone.id) this.zoneLandmarkPos = g.position.clone()
    }
    // 5) City traffic — only the streets of the city you're in drive
    for (const t of this.traffic) t.mesh.visible = t.zone === zone.id
    // 6) Asphalt character — every city's tarmac has its own tint: Mumbai's
    //    dusty dark, London's wet slate, Beijing's day-lit grey… The road is
    //    the thing you stare at, so it carries the city identity too.
    if (this.groundMat) this.groundMat.color.set(zone.road)
    // 7) City air — fog colour/density + lane + sidewalk paint override. The
    //    atmosphere itself belongs to the city, not just the buildings.
    this.applyZoneAtmosphere(zone)
    // 8) Time of day — each city lives in its own light. Dusk/day cities blend
    //    the whole lighting rig (sky, sun, fog, windows, headlights) over 9s.
    this.applyZoneHour(zone)
    void banner
  }

  /** Per-city atmosphere finish — fog colour + density + street paint. Called
      on arrival and re-applied after any theme blend so the city's air always
      wins: London haze vs Tokyo pink gloom vs New York deep blue. Night cities
      use their own palette; day/dusk cities let the hour's light own the air. */
  private applyZoneAtmosphere(zone: WorldZone): void {
    const arch = zone.arch
    if (!arch) return
    if ((arch.hour ?? 'night') === 'night') {
      const fog = this.scene.fog as THREE.FogExp2 | null
      if (fog) {
        if (arch.fog) fog.color.set(arch.fog)
        if (arch.fogDensity) fog.density = arch.fogDensity
      }
    }
    if (this.laneMat && arch.laneCol) this.laneMat.color.setHex(arch.laneCol)
    if (this.walkMat && arch.walkCol) this.walkMat.color.setHex(arch.walkCol)
  }

  /** Per-city time of day — drives the EXISTING theme blend machinery to a
      pseudo-theme: night cities keep the player's own theme; dusk cities get
      a golden-hour sun; day cities get full daylight (windows off, headlights
      off, bright sky + fog, strong sun). Arrivals blend over 9s so leaving
      Tokyo at night and crossing into daylight Beijing feels like travelling
      across the world, not a cut. */
  private applyZoneHour(zone: WorldZone): void {
    const arch = zone.arch
    const hour = arch?.hour ?? 'night'
    const base = getTheme(this.hooks.getSave().theme)
    if (hour === 'night') {
      // Leave the city's light to the player's theme — return to it if a
      // previous day/dusk zone had moved the rig.
      if (this.lastZoneHour !== 'night') this.applyTheme(base, 4.5)
      this.lastZoneHour = 'night'
      return
    }
    const day = hour === 'day'
    const t = { ...base, id: day ? 'day' : 'golden' } as ReturnType<typeof getTheme>
    t.sky = day ? 0x8ec8f0 : 0x2a1608
    t.fog = day ? 0xaed4ee : 0x58290a
    t.fogDensity = day ? 0.0011 : 0.005
    t.ambient = day ? 0xcfe0f5 : 0xffb26b
    t.ambientIntensity = day ? 0.7 : 1.2
    t.moon = day ? 0xfff3da : 0xffd9a0
    t.moonIntensity = day ? 1.7 : 1.05
    t.ground = day ? 0x8b95a1 : 0x171008
    t.water = day ? 0x3f7fab : 0x3a2410
    this.applyTheme(t, 4.5)
    this.lastZoneHour = hour
  }

  private genSky(): void {
    // Moon + halo
    const moonDisc = new THREE.Mesh(new THREE.CircleGeometry(34, 32), new THREE.MeshBasicMaterial({ color: 0xe8f1ff, fog: false }))
    moonDisc.position.set(-420, 320, -620)
    moonDisc.lookAt(0, 0, 0)
    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(80, 32),
      new THREE.MeshBasicMaterial({ color: 0x8fb4ff, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, fog: false, depthWrite: false })
    )
    halo.position.copy(moonDisc.position).multiplyScalar(1.001)
    halo.lookAt(0, 0, 0)
    this.scene.add(moonDisc, halo)

    // Stars
    const rand = seededRand(7)
    const count = 420
    const pos = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const ang = rand() * Math.PI * 2
      const elev = 0.15 + rand() * 0.8
      const r = 1100
      pos[i * 3] = Math.cos(ang) * Math.cos(elev) * r
      pos[i * 3 + 1] = Math.sin(elev) * r
      pos[i * 3 + 2] = Math.sin(ang) * Math.cos(elev) * r
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const stars = new THREE.Points(geom, new THREE.PointsMaterial({ color: 0xcfe0ff, size: 2.2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.8 }))
    this.scene.add(stars)
  }

  private genPuddles(): void {
    // Fake neon reflections: soft additive pools on the asphalt
    const rand = seededRand(66)
    const tex = makeGlowTexture()
    const colors = [0x22d3ee, 0xff2d95, 0x8fb4ff]
    for (let i = 0; i < 46; i++) {
      const s = 3 + rand() * 7
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        color: colors[Math.floor(rand() * colors.length)],
        transparent: true,
        opacity: 0.10 + rand() * 0.08,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const p = new THREE.Mesh(new THREE.PlaneGeometry(s, s * (0.5 + rand() * 0.5)), mat)
      const k = Math.floor(rand() * (N + 1))
      const onX = rand() > 0.5
      const c = -HALF + ROAD / 2 + k * CELL
      const along = (rand() * 2 - 1) * (HALF - 10)
      p.position.set(onX ? along : c + (rand() - 0.5) * 6, 0.015, onX ? c + (rand() - 0.5) * 6 : along)
      p.rotation.x = -Math.PI / 2
      p.rotation.z = rand() * Math.PI
      this.scene.add(p)
    }
  }

  // =============== REALISM PASS: PAINT / SIGNALS / HARBOUR / CLOUDS ===============
  private trafficLights: { red: THREE.MeshBasicMaterial; amber: THREE.MeshBasicMaterial; green: THREE.MeshBasicMaterial; axis: 'ew' | 'ns' }[] = []
  private lightIntersections: Array<{ x: number; z: number }> = []
  private buoys: Array<{ mesh: THREE.Group; phase: number }> = []
  private ships: Array<{ mesh: THREE.Group; r: number; speed: number; ang: number }> = []
  private sprayPoints: THREE.Points | null = null
  private cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, transparent: true, opacity: 0.9 })
  private skyCache: Record<string, THREE.Texture> = {}
  private rainSplashes: THREE.Mesh[] = []
  private splashTimes = new Float32Array(0)
  private stallSpots: number[] = []
  private stallSteam: { sprite: THREE.Sprite; phase: number; base: THREE.Vector3 }[] = []
  private idlers: { mesh: THREE.Object3D; mixer: THREE.AnimationMixer; baseY?: number }[] = []
  // Beach life: animated beach balls + campfire light flicker
  private beachBalls: { mesh: THREE.Mesh; a: THREE.Vector3; b: THREE.Vector3; phase: number; dur: number }[] = []
  private fireLights: { light: THREE.PointLight; phase: number; glow: THREE.Sprite }[] = []
  private moonTrackMat: THREE.MeshBasicMaterial | null = null
  private foamNight = 1

  // ---- Road events -------------------------------------------------------
  // The car NEVER stops for mechanics (no fuel, no tolls). The ONLY things
  // allowed to halt traffic are visible, physical blockers the player can
  // read at a glance: ① accident scenes with wrecked cars + a gathered
  // crowd, ② rush-hour jams where the avenues crawl.
  private accident: {
    group: THREE.Group
    axis: 'x' | 'z'
    lat: number
    along: number
    boxStart: number
    boxCount: number
    idlerStart: number
    idlerCount: number
    hazardMats: THREE.MeshBasicMaterial[]
    smokeTimer: number
    despawnAt: number
    warned: boolean
  } | null = null
  private accidentTimer = 45
  private rushActive = false
  private rushUntil = 0
  private rushTimer = 150
  private rushCars: TrafficCar[] = []

  // ---- Body damage -------------------------------------------------------
  // Simulator-style damage: crashes dent the car, heavy damage bleeds speed,
  // the paint fades, smoke pours out — and at 100% the car EXPLODES (WRECKED).
  private damage = 0
  private damageSmokeT = 0
  private damageWarned50 = false
  private damageWarned80 = false
  private damageCommitAt = 0
  private wrecked = false
  private wreckBurnT = 0
  /** the most recent damaging hit — attributed on the WRECKED card */
  private lastHitKmh = 0
  private lastHitCause = ''

  // ---- World Circuit (v2) --------------------------------------------------
  // The odometer never resets: total km driven across ALL runs drives the
  // endless cycle of real city zones. Every ZONE_LENGTH_KM the world
  // transforms (skyline silhouette, landmark, architecture mood, window glow).
  private worldKm = 0
  private lastZoneId = ''
  /** per-zone hero landmark silhouettes on the skyline ring; one visible at a time */
  private zoneLandmarks = new Map<string, THREE.Group>()
  // v2.1 per-city architecture packs — each zone owns a fully restyled city
  // (roof silhouettes, window grids, neon, balconies) built from the SAME
  // physical placements, so collision never changes while every city reads
  // architecturally different.
  private zoneCities = new Map<string, THREE.Group>()
  private zoneWinMats = new Map<string, THREE.MeshBasicMaterial>()
  private zoneCityPeds = new Map<string, THREE.Group[]>()
  /** v2.2 per-city skyline silhouette DNA — seeded height multiplier per
      building, so London stays terraced while New York rises into canyons */
  private zoneHMaps = new Map<string, Map<Placement, number>>()
  /** v2.2 per-city time of day — which light rig the city you're in runs */
  private lastZoneHour: 'night' | 'dusk' | 'day' = 'night'
  /** per-zone glow lights + city-name billboards + world anchors for the reveal cam */
  private zoneLandmarkLights = new Map<string, THREE.PointLight>()
  private zoneSigns = new Map<string, THREE.Mesh>()
  private zoneLandmarkPos: THREE.Vector3 | null = null
  /** seconds left of the cinematic "arrival reveal" — camera drifts up to the landmark */
  private zoneCamT = 0

  /** real-time seconds of kill-cam slow motion left after the explosion */
  private slowmoT = 0
  /** beach hint: edge-trigger + 45s cooldown so the toast never nags */
  private onSand = false
  private sandHintT = 0
  private baseBodyColor = new THREE.Color(0x8a93a6)
  private hornHeld = false
  private hornCd = 0
  private screamCd = 0
  // Police chopper spotlight that pins the car during a chase
  private chaseSpot: THREE.SpotLight | null = null
  private chaseCone: THREE.Mesh | null = null
  // Lighthouse island: rotating beam + visit-reward cooldown
  private lighthouseBeam: THREE.Mesh | null = null
  private islandCd = 0

  private skyBackground(t: ReturnType<typeof getTheme>): THREE.Texture | THREE.Color {
    if (this.skyCache[t.id]) return this.skyCache[t.id]
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 512
    const g = c.getContext('2d')
    if (!g) return new THREE.Color(t.sky)
    const tops: Record<string, string> = {
      day: '#3f8ef0',
      golden: '#c96a2e',
      sakura: '#4a2b52',
      midnight: '#060a16',
      acid: '#0a1410',
    }
    const grad = g.createLinearGradient(0, 0, 0, 512)
    grad.addColorStop(0, tops[t.id] ?? '#060a16')
    const skyHex = '#' + t.sky.toString(16).padStart(6, '0')
    grad.addColorStop(0.55, skyHex)
    grad.addColorStop(1, skyHex)
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 512)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    this.skyCache[t.id] = tex
    return tex
  }

  /** Real road paint: dashed centre lines, kerb edge lines and zebra crossings —
      the biggest single "this is a real city" readability win. */
  private genRoadMarkings(): void {
    const paint = new THREE.MeshBasicMaterial({ color: 0x9aa4b5 })
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const s = new THREE.Vector3(1, 1, 1)
    const dashGeom = new THREE.BoxGeometry(2.8, 0.03, 0.18)
    const dashMax = (N + 1) * Math.ceil((HALF * 2) / 6) * 2
    const dash = new THREE.InstancedMesh(dashGeom, paint, dashMax)
    let di = 0
    for (let k = 0; k <= N; k++) {
      const c = -HALF + ROAD / 2 + k * CELL
      for (let t = -HALF + 8; t < HALF - 8; t += 6) {
        e.set(0, 0, 0); q.setFromEuler(e)
        m.compose(new THREE.Vector3(t, 0.025, c), q, s); dash.setMatrixAt(di++, m)
        e.set(0, Math.PI / 2, 0); q.setFromEuler(e)
        m.compose(new THREE.Vector3(c, 0.025, t), q, s); dash.setMatrixAt(di++, m)
      }
    }
    dash.count = di
    dash.instanceMatrix.needsUpdate = true
    this.scene.add(dash)
    // Zebra crossings at every intersection (both roads)
    const zebraGeom = new THREE.BoxGeometry(2.4, 0.03, 1.5)
    const zebra = new THREE.InstancedMesh(zebraGeom, paint, (N + 1) * (N + 1) * 16)
    let zi = 0
    for (let kx = 0; kx <= N; kx++) {
      for (let kz = 0; kz <= N; kz++) {
        const cX = -HALF + ROAD / 2 + kx * CELL
        const cZ = -HALF + ROAD / 2 + kz * CELL
        for (let t = -5.5; t <= 5.5; t += 1.4) {
          // crossing of the x-road: stripes run along x
          e.set(0, 0, 0); q.setFromEuler(e)
          m.compose(new THREE.Vector3(cX, 0.025, cZ + t), q, s); zebra.setMatrixAt(zi++, m)
          // crossing of the z-road: stripes run along z
          e.set(0, Math.PI / 2, 0); q.setFromEuler(e)
          m.compose(new THREE.Vector3(cX + t, 0.025, cZ), q, s); zebra.setMatrixAt(zi++, m)
        }
      }
    }
    zebra.count = zi
    zebra.instanceMatrix.needsUpdate = true
    this.scene.add(zebra)
    // Kerb edge lines along every road
    const edgeGeom = new THREE.BoxGeometry(1, 0.03, 0.16)
    const edge = new THREE.InstancedMesh(edgeGeom, paint, (N + 1) * 4)
    let ei = 0
    for (let k = 0; k <= N; k++) {
      const c = -HALF + ROAD / 2 + k * CELL
      const off = ROAD / 2 - 0.45
      for (const side of [-1, 1]) {
        e.set(0, 0, 0); q.setFromEuler(e)
        m.compose(new THREE.Vector3(0, 0.025, c + side * off), q, new THREE.Vector3(HALF * 2, 1, 1))
        edge.setMatrixAt(ei++, m)
        m.compose(new THREE.Vector3(c + side * off, 0.025, 0), q, new THREE.Vector3(1, 1, HALF * 2))
        edge.setMatrixAt(ei++, m)
      }
    }
    edge.count = ei
    edge.instanceMatrix.needsUpdate = true
    this.scene.add(edge)
  }

  /** Signal poles at the four central crossroads — animated red/amber/green so
      intersections actually govern traffic like a real city. */
  private genTrafficLights(): void {
    const centers: number[] = []
    for (let k = 0; k <= N; k++) centers.push(-HALF + ROAD / 2 + k * CELL)
    centers.sort((a, b) => Math.abs(a) - Math.abs(b))
    const avenues = centers.slice(0, 2)
    const poleGeom = new THREE.CylinderGeometry(0.09, 0.12, 5.2, 6)
    const armGeom = new THREE.BoxGeometry(0.07, 0.07, 1.5)
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.6 })
    const housingGeom = new THREE.BoxGeometry(0.34, 0.95, 0.24)
    const housingMat = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.5 })
    const lensGeom = new THREE.SphereGeometry(0.13, 10, 8)
    const corners: Array<{ dx: number; dz: number; axis: 'ew' | 'ns' }> = [
      { dx: -1, dz: -1, axis: 'ew' }, { dx: 1, dz: -1, axis: 'ew' },
      { dx: -1, dz: 1, axis: 'ns' }, { dx: 1, dz: 1, axis: 'ns' },
    ]
    for (const c of avenues) {
      for (const c2 of avenues) {
        this.lightIntersections.push({ x: c, z: c2 })
        for (const cor of corners) {
          const g = new THREE.Group()
          const pole = new THREE.Mesh(poleGeom, poleMat)
          pole.position.y = 2.6
          g.add(pole)
          const arm = new THREE.Mesh(armGeom, poleMat)
          arm.position.set(cor.dx * 1.15, 4.6, 0)
          g.add(arm)
          const housing = new THREE.Mesh(housingGeom, housingMat)
          housing.position.set(cor.dx * 1.6, 4.6, 0)
          g.add(housing)
          const red = new THREE.MeshBasicMaterial({ color: 0x2a0a0c })
          const amber = new THREE.MeshBasicMaterial({ color: 0x2a200a })
          const green = new THREE.MeshBasicMaterial({ color: 0x0a2a14 })
          const rM = new THREE.Mesh(lensGeom, red); rM.position.set(cor.dx * 1.6, 5.02, 0)
          const aM = new THREE.Mesh(lensGeom, amber); aM.position.set(cor.dx * 1.6, 4.62, 0)
          const gM = new THREE.Mesh(lensGeom, green); gM.position.set(cor.dx * 1.6, 4.22, 0)
          g.add(rM, aM, gM)
          g.position.set(c + cor.dx * 8.4, 0, c2 + cor.dz * 8.4)
          g.rotation.y = cor.dx < 0 ? Math.PI : 0
          this.scene.add(g)
          // Solid pole: the car must not drive through signal posts
          this.addPropCollider({ minX: g.position.x - 0.3, maxX: g.position.x + 0.3, minZ: g.position.z - 0.3, maxZ: g.position.z + 0.3 })
          this.trafficLights.push({ red, amber, green, axis: cor.axis })
        }
      }
    }
  }

  private updateTrafficLights(): void {
    const ph = this.time % 14
    for (const tl of this.trafficLights) {
      const ew = tl.axis === 'ew'
      const phase = ew ? (ph < 8 ? 'g' : ph < 9.5 ? 'a' : 'r') : ph < 9.5 ? 'r' : ph < 12.5 ? 'g' : 'a'
      tl.red.color.setHex(phase === 'r' ? 0xff2233 : 0x2a0a0c)
      tl.amber.color.setHex(phase === 'a' ? 0xffb020 : 0x2a200a)
      tl.green.color.setHex(phase === 'g' ? 0x35ff8a : 0x0a2a14)
    }
  }

  /** Living harbour: bobbing channel buoys, slow coasters with nav lights and a
      glinting spray field off the beach — the ocean finally feels alive. */
  private genHarborLife(rand: () => number): void {
    const beachOuter = HALF + 46
    const buoyBody = new THREE.CylinderGeometry(0.6, 0.8, 1.2, 8)
    const buoyMat = new THREE.MeshStandardMaterial({ color: 0xd94f3d, roughness: 0.6 })
    const lightGeom = new THREE.SphereGeometry(0.16, 8, 6)
    const redMat = new THREE.MeshBasicMaterial({ color: 0xff3344 })
    for (let i = 0; i < 8; i++) {
      const g = new THREE.Group()
      const body = new THREE.Mesh(buoyBody, buoyMat)
      body.position.y = 0.5
      const light = new THREE.Mesh(lightGeom, redMat)
      light.position.y = 1.35
      g.add(body, light)
      const ang = rand() * Math.PI * 2
      const r = beachOuter + 14 + rand() * 26
      g.position.set(Math.cos(ang) * r, -0.2, Math.sin(ang) * r)
      this.scene.add(g)
      this.buoys.push({ mesh: g, phase: rand() * Math.PI * 2 })
    }
    // Two slow coasters far offshore, circling the island with nav lights
    for (let i = 0; i < 2; i++) {
      const g = new THREE.Group()
      const hull = new THREE.Mesh(new THREE.BoxGeometry(16, 4, 5), new THREE.MeshStandardMaterial({ color: i ? 0x5b6670 : 0x9aa3ab, roughness: 0.7 }))
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 3.4), new THREE.MeshStandardMaterial({ color: 0x39424e, roughness: 0.6 }))
      cabin.position.set(-1, 2.4, 0)
      const nav = new THREE.Mesh(lightGeom, new THREE.MeshBasicMaterial({ color: 0x66ff88 }))
      nav.position.set(0, 4.6, 0)
      g.add(hull, cabin, nav)
      g.userData.navMat = nav.material as THREE.MeshBasicMaterial
      const r = 300 + rand() * 60
      const ang = rand() * Math.PI * 2
      g.position.set(Math.cos(ang) * r, 0.3, Math.sin(ang) * r)
      g.rotation.y = -ang - Math.PI / 2
      this.scene.add(g)
      this.ships.push({ mesh: g, r, speed: 0.1 + rand() * 0.07, ang })
    }
    // Spray glitter between the foam lines — reads as breaking surf
    const COUNT = 380
    const pos = new Float32Array(COUNT * 3)
    for (let i = 0; i < COUNT; i++) {
      const ang = rand() * Math.PI * 2
      const r = beachOuter + 4 + rand() * 22
      pos[i * 3] = Math.cos(ang) * r
      pos[i * 3 + 1] = 0.2 + rand() * 0.7
      pos[i * 3 + 2] = Math.sin(ang) * r
    }
    const pg = new THREE.BufferGeometry()
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.sprayPoints = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xe8fbff, size: 0.7, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }))
    this.sprayPoints.frustumCulled = false
    this.scene.add(this.sprayPoints)
  }

  private updateHarborLife(dt: number): void {
    for (const b of this.buoys) {
      b.mesh.position.y = -0.2 + Math.sin(this.time * 1.6 + b.phase) * 0.18
      const lm = b.mesh.children[1] as THREE.Mesh
      ;(lm.material as THREE.MeshBasicMaterial).color.setHex(Math.sin(this.time * 3 + b.phase) > 0 ? 0xff4455 : 0x551418)
    }
    for (const s of this.ships) {
      s.ang += s.speed * dt
      s.mesh.position.set(Math.cos(s.ang) * s.r, 0.3 + Math.sin(this.time * 0.8 + s.ang) * 0.12, Math.sin(s.ang) * s.r)
      s.mesh.rotation.y = -s.ang - Math.PI / 2
      const nav = s.mesh.userData.navMat as THREE.MeshBasicMaterial
      nav.color.setHex(Math.sin(this.time * 2.2 + s.ang * 3) > 0 ? 0x66ff88 : 0x14551f)
    }
    if (this.sprayPoints) {
      ;(this.sprayPoints.material as THREE.PointsMaterial).opacity = 0.35 + Math.sin(this.time * 2.3) * 0.18
    }
    // Food-stall steam plumes
    for (const st of this.stallSteam) {
      const t = (this.time * 0.5 + st.phase) % 1
      st.sprite.position.set(st.base.x + Math.sin(this.time * 0.7 + st.phase) * 0.3, st.base.y + t * 2.0, st.base.z)
      ;(st.sprite.material as THREE.SpriteMaterial).opacity = Math.sin(t * Math.PI) * 0.3
    }
  }

  /** Moonlight road: an additive shimmer strip on the bay running toward the moon.
      Displaced by the SAME swell shader as the sea, so the light-track rides the
      waves — at night the ocean finally separates from the horizon. */
  private genMoonTrack(): void {
    const moonDir = new THREE.Vector2(-420, -620).normalize()
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 256
    const g = c.getContext('2d')
    if (!g) return
    const grad = g.createLinearGradient(0, 0, 64, 0)
    grad.addColorStop(0, 'rgba(190,220,255,0)')
    grad.addColorStop(0.5, 'rgba(215,238,255,0.9)')
    grad.addColorStop(1, 'rgba(190,220,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 256)
    const lengthFade = g.createLinearGradient(0, 0, 0, 256)
    lengthFade.addColorStop(0, 'rgba(0,0,0,1)')
    lengthFade.addColorStop(0.22, 'rgba(0,0,0,0)')
    lengthFade.addColorStop(1, 'rgba(0,0,0,1)')
    g.globalCompositeOperation = 'destination-out'
    g.fillStyle = lengthFade
    g.fillRect(0, 0, 64, 256)
    const tex = new THREE.CanvasTexture(c)
    tex.wrapT = THREE.RepeatWrapping
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    })
    this.moonTrackMat = mat
    const geom = new THREE.PlaneGeometry(64, 560, 6, 48)
    geom.rotateX(-Math.PI / 2)
    geom.rotateY(Math.atan2(moonDir.x, moonDir.y))
    // Same swell displacement as the water surface — the track bobs with the sea
    const timeU = this.scene.userData.waterTime as { value: number } | undefined
    if (timeU) {
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = timeU
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            {
              vec4 wpos = modelMatrix * vec4(position, 1.0);
              float wx = wpos.x;
              float wz = wpos.z;
              float swell1 = sin(wx * 0.055 + uTime * 1.05) * 0.38;
              float swell2 = sin(wz * 0.075 - uTime * 0.85) * 0.26;
              float swell3 = sin((wx + wz) * 0.032 + uTime * 0.55) * 0.55;
              float chop = sin(wx * 0.21 + wz * 0.17 + uTime * 1.9) * 0.13;
              transformed.z += swell1 + swell2 + swell3 + chop;
            }`
          )
      }
    }
    const mesh = new THREE.Mesh(geom, mat)
    const centerDist = 252 + 280
    mesh.position.set(moonDir.x * centerDist, -0.02, moonDir.y * centerDist)
    mesh.renderOrder = 2
    this.scene.add(mesh)
  }

  /** Soft cumulus at altitude — a real sky instead of a flat backdrop. */
  private genClouds(rand: () => number): void {
    const group = new THREE.Group()
    const blobGeom = new THREE.SphereGeometry(1, 9, 7)
    for (let i = 0; i < 12; i++) {
      const c = new THREE.Group()
      const blobs = 3 + Math.floor(rand() * 3)
      for (let b = 0; b < blobs; b++) {
        const blob = new THREE.Mesh(blobGeom, this.cloudMat)
        const s = 16 + rand() * 24
        blob.scale.set(s * (0.85 + rand() * 0.5), s * 0.32, s * (0.9 + rand() * 0.4))
        blob.position.set(b * 20 + rand() * 8, rand() * 4, (rand() - 0.5) * 12)
        c.add(blob)
      }
      const ang = rand() * Math.PI * 2
      const r = 420 + rand() * 380
      c.position.set(Math.cos(ang) * r, 250 + rand() * 120, Math.sin(ang) * r)
      c.rotation.y = rand() * Math.PI
      group.add(c)
    }
    this.scene.add(group)
  }

  /** Real characters standing around: customers queuing at the food stalls and
      beach-goers gazing out at the surf — idle anim, no fake walking. */
  private genIdleCharacters(rand: () => number): void {
    const charKeys = Object.keys(this.assets.chars)
    if (charKeys.length === 0) return
    const tints = [0xb9bec6, 0x8f867b, 0x6d7683, 0x7d6f7a, 0x5f6b5d, 0x9c8f7d, 0x565e6b, 0xa89f8d, 0x4f5a67]
    const makeIdler = (px: number, pz: number, rot: number): void => {
      const key = charKeys[Math.floor(rand() * charKeys.length)]
      const { obj, clips } = cloneCharacter(this.assets, key)
      const bb = new THREE.Box3().setFromObject(obj)
      const h = bb.max.y - bb.min.y
      const s = h > 0.01 ? (1.62 + rand() * 0.28) / h : 1
      obj.scale.setScalar(s)
      const tint = new THREE.Color(tints[Math.floor(rand() * tints.length)])
      tint.multiplyScalar(0.82 + rand() * 0.36)
      obj.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          const mat = (m.material as THREE.MeshStandardMaterial).clone()
          mat.color = tint.clone()
          m.material = mat
        }
      })
      obj.position.y = -bb.min.y * s
      const mixer = new THREE.AnimationMixer(obj)
      const idleClip = clips.find((c) => c.name.includes('idle')) ?? clips.find((c) => c.name.includes('stand')) ?? clips[0]
      const action = mixer.clipAction(idleClip)
      action.play()
      action.timeScale = 0.9 + rand() * 0.3
      const wrap = new THREE.Group()
      wrap.add(obj)
      wrap.position.set(px, 0, pz)
      wrap.rotation.y = rot
      this.scene.add(wrap)
      this.idlers.push({ mesh: wrap, mixer })
    }
    // Customers at the food stalls (front of the counter)
    for (let i = 0; i < this.stallSpots.length; i += 2) {
      const sx = this.stallSpots[i]
      const sz = this.stallSpots[i + 1]
      const n = 1 + Math.floor(rand() * 2)
      for (let k = 0; k < n; k++) {
        makeIdler(sx + 1.2 + rand() * 1.6, sz + 1.6 + rand() * 1.2, Math.PI + (rand() - 0.5) * 1.2)
      }
    }
    // Beach-goers on the sand ring, watching the sea
    const beachRand = seededRand(908)
    for (let i = 0; i < 10; i++) {
      const ang = beachRand() * Math.PI * 2
      const out = HALF + 14 + beachRand() * 26
      makeIdler(Math.cos(ang) * out, Math.sin(ang) * out, -ang + Math.PI + (beachRand() - 0.5) * 0.8)
    }
  }

  /** Phones: the shadow pass re-draws every caster. Detailed instanced props
      (hundreds of thousands of triangles across the city) and the skinned
      crowd stop casting; buildings, the player's car and traffic keep their
      shadows, which is what the eye reads. */
  private trimShadowsForPhones(): void {
    this.scene.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) { o.castShadow = false; return }
      const im = o as THREE.InstancedMesh
      if (!im.isInstancedMesh || !im.castShadow) return
      const g = im.geometry
      const tris = (g.index ? g.index.count : g.attributes.position.count) / 3
      if (tris * im.count > 4000) im.castShadow = false
    })
  }

  /** Phones: every character is a skinned mesh — its own draw call plus a
      bone upload — so beyond 75 m (a few pixels tall, in the fog) they are
      not drawn at all, and between 40 and 75 m they animate ~5 times a second
      (with the time they skipped). Close ones animate every frame. */
  private animLodDt = new WeakMap<THREE.AnimationMixer, number>()
  private tickMixer(mixer: THREE.AnimationMixer, obj: THREE.Object3D, x: number, z: number, dt: number): void {
    if (!this.lowPower) { mixer.update(dt); return }
    const dx = x - this.pos.x
    const dz = z - this.pos.z
    const d2 = dx * dx + dz * dz
    obj.visible = d2 < 75 * 75
    if (!obj.visible) return
    const acc = (this.animLodDt.get(mixer) ?? 0) + dt
    if (d2 < 1600 || acc >= 0.2) {
      mixer.update(acc)
      this.animLodDt.set(mixer, 0)
    } else {
      this.animLodDt.set(mixer, acc)
    }
  }

  private updateIdlers(dt: number): void {
    for (const id of this.idlers) {
      // zone pack idlers: skip the cities that aren't on screen (their group
      // is hidden — animation costs for 7 hidden casts would be waste)
      if ((id.mesh.parent as THREE.Object3D | null)?.visible === false) continue
      this.tickMixer(id.mixer, id.mesh, id.mesh.position.x, id.mesh.position.z, dt)
      // subtle life: a gentle idle bob so the crowd never looks frozen
      id.mesh.position.y = (id.baseY ?? 0) + Math.abs(Math.sin(this.time * 0.9 + id.mesh.position.x * 0.7)) * 0.02
    }
  }

  /** Beach life: beach balls arc between players, campfires flicker. */
  private updateBeachLife(): void {
    for (const b of this.beachBalls) {
      const p = ((this.time / b.dur + b.phase) % 1 + 1) % 1
      b.mesh.position.lerpVectors(b.a, b.b, p)
      b.mesh.position.y += Math.sin(p * Math.PI) * 1.6 // parabolic toss
      b.mesh.rotation.x += 0.04
    }
    for (const f of this.fireLights) {
      const w = Math.sin(this.time * 9 + f.phase) * 0.5 + Math.sin(this.time * 23 + f.phase * 2) * 0.3
      f.light.intensity = 7 + w * 2.2
      ;(f.glow.material as THREE.SpriteMaterial).opacity = 0.7 + w * 0.18
      f.glow.scale.setScalar(1.6 + w * 0.18)
    }
  }


  private birdMesh: THREE.InstancedMesh | null = null
  private birdData: Array<{ cx: number; cz: number; r: number; speed: number; phase: number; h: number; dir: 1 | -1; flap: number }> = []
  private birdDummy = new THREE.Object3D()

  /** Concrete jersey-barrier dividers on the two central avenues + police barricade clusters at intersections. */
  private genRoadFurniture(rand: () => number): void {
    const centers: number[] = []
    for (let k = 0; k <= N; k++) centers.push(-HALF + ROAD / 2 + k * CELL)
    centers.sort((a, b) => Math.abs(a) - Math.abs(b))
    const avenues = centers.slice(0, 2)

    // Jersey barriers, every ~4.1m with small gaps, following the avenue centerline.
    // IMPORTANT: the median MUST break at every intersection — a solid wall
    // through the crosswalk traps cars (and players) with no way across.
    const allCenters: number[] = []
    for (let k = 0; k <= N; k++) allCenters.push(-HALF + ROAD / 2 + k * CELL)
    const nearCrossing = (t: number) => allCenters.some((c) => Math.abs(t - c) < ROAD / 2 + 3)
    const placements: Array<{ x: number; z: number; rot: number }> = []
    for (let ai = 0; ai < avenues.length; ai++) {
      const c = avenues[ai]
      for (let t = -HALF + 10; t < HALF - 10; t += 4.1) {
        if (rand() < 0.07) continue
        if (nearCrossing(t)) continue
        // Keep the central garage plaza clean — the player spawns there and
        // their very first drive must not be a slalom of concrete
        if (Math.abs(t) < 45 && Math.abs(c) < 45) continue
        // Keep the downtown border (±82) clear — locked-district bounces happen
        // there, and concrete right at the wall wedged cars permanently
        if (Math.abs(Math.abs(t) - 82) < 9) continue
        placements.push(ai === 0 ? { x: t, z: c, rot: 0 } : { x: c, z: t, rot: Math.PI / 2 })
      }
    }
    const barrierGeom = new THREE.BoxGeometry(0.62, 0.92, 3.6)
    const stripeGeom = new THREE.BoxGeometry(0.66, 0.17, 3.6)
    const barrierMat = new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.85 })
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xd7dae0, roughness: 0.8, emissive: 0x222630, emissiveIntensity: 0.25 })
    const barriers = new THREE.InstancedMesh(barrierGeom, barrierMat, placements.length)
    const stripes = new THREE.InstancedMesh(stripeGeom, stripeMat, placements.length)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const eul = new THREE.Euler()
    const one = new THREE.Vector3(1, 1, 1)
    placements.forEach((p, i) => {
      eul.set(0, p.rot, 0)
      q.setFromEuler(eul)
      m.compose(new THREE.Vector3(p.x, 0.46, p.z), q, one)
      barriers.setMatrixAt(i, m)
      m.compose(new THREE.Vector3(p.x, 0.87, p.z), q, one)
      stripes.setMatrixAt(i, m)
      this.buildings.push({ minX: p.x - 0.5, maxX: p.x + 0.5, minZ: p.z - 0.5, maxZ: p.z + 0.5 })
    })
    barriers.instanceMatrix.needsUpdate = true
    stripes.instanceMatrix.needsUpdate = true
    barriers.castShadow = true
    this.scene.add(barriers, stripes)

    // Police barricade clusters: striped A-frame boards + traffic cones near intersections
    const barricadeTex = (() => {
      const c = document.createElement('canvas')
      c.width = 128
      c.height = 32
      const g = c.getContext('2d')
      if (!g) return null
      for (let i = 0; i < 8; i++) {
        g.fillStyle = i % 2 ? '#e8ecf2' : '#e0332e'
        g.beginPath()
        g.moveTo(i * 16, 32)
        g.lineTo(i * 16 + 16, 32)
        g.lineTo(i * 16 + 8, 0)
        g.closePath()
        g.fill()
      }
      const t = new THREE.CanvasTexture(c)
      t.anisotropy = 4
      return t
    })()
    const boardGeom = new THREE.BoxGeometry(2.4, 0.5, 0.07)
    const legGeom = new THREE.BoxGeometry(0.09, 0.85, 0.5)
    const boardMat = new THREE.MeshStandardMaterial({ map: barricadeTex ?? undefined, color: barricadeTex ? 0xffffff : 0xe0332e, roughness: 0.6 })
    const legMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.5, metalness: 0.6 })
    const coneGeom = new THREE.ConeGeometry(0.24, 0.62, 10)
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a1f, roughness: 0.55, emissive: 0x521800, emissiveIntensity: 0.3 })
    for (let ai = 0; ai < avenues.length; ai++) {
      const c = avenues[ai]
      const horizontal = ai === 0
      for (let k = 0; k <= N; k++) {
        const cross = -HALF + ROAD / 2 + k * CELL
        if (Math.abs(cross - c) < 1) continue
        if (rand() > 0.3) continue
        const offA = rand() > 0.5 ? 4.5 : -4.5
        const offB = rand() > 0.5 ? 4.5 : -4.5
        const px = horizontal ? cross + offA : c + offA
        const pz = horizontal ? c + offB : cross + offB
        const rot = rand() * Math.PI
        // Two crossed barricade boards per cluster — reads as a real road closure
        for (let bCount = 0; bCount < 2; bCount++) {
          const board = new THREE.Mesh(boardGeom, boardMat)
          const bx = px + (bCount === 0 ? 0 : Math.cos(rot + Math.PI / 2) * 3.2)
          const bz = pz + (bCount === 0 ? 0 : -Math.sin(rot + Math.PI / 2) * 3.2)
          board.position.set(bx, 0.72, bz)
          board.rotation.y = rot + bCount * 0.35
          const legL = new THREE.Mesh(legGeom, legMat)
          legL.position.set(-1.05, -0.28, 0)
          const legR = new THREE.Mesh(legGeom, legMat)
          legR.position.set(1.05, -0.28, 0)
          board.add(legL, legR)
          this.scene.add(board)
          this.buildings.push({ minX: bx - 1.4, maxX: bx + 1.4, minZ: bz - 0.6, maxZ: bz + 0.6 })
        }
        for (let ci = 0; ci < 6; ci++) {
          const cone = new THREE.Mesh(coneGeom, coneMat)
          const off = (ci - 2.5) * 1.6
          cone.position.set(px + Math.cos(rot) * off + Math.sin(rot) * 1.4, 0.31, pz - Math.sin(rot) * off + Math.cos(rot) * 1.4)
          this.scene.add(cone)
        }
      }
    }
  }

  /** Glowing street-food stalls tucked into interior block corners — steam,
      warm glow and queuing customers make the sidewalks feel lived-in. */
  private genStreetFood(rand: () => number): void {
    const names = ['RAMEN', 'TACOS', 'BOBA', 'BBQ', 'NOODLES', 'TEA HOUSE', 'HOTDOG', 'DUMPLINGS', 'POKE', 'CREPES']
    const palette = [0xc0392b, 0xe67e22, 0x16a085, 0x8e44ad, 0xd35400, 0x27ae60, 0xc2185b, 0x2c3e50, 0xf39c12, 0x2980b9]
    const bodyGeom = new THREE.BoxGeometry(2.4, 2.0, 1.6)
    const counterGeom = new THREE.PlaneGeometry(2.2, 0.8)
    const awningGeom = new THREE.PlaneGeometry(2.9, 1.25)
    const signGeom = new THREE.PlaneGeometry(2.3, 0.5)
    const glowTex = makeGlowTexture()
    let placed = 0
    this.stallSpots = []
    for (let i = 1; i < N - 1 && placed < 10; i++) {
      for (let j = 1; j < N - 1 && placed < 10; j++) {
        if (i === GARAGE_I && j === GARAGE_J) continue
        if (rand() > 0.22) continue
        const bx = blockOrigin(i)
        const bz = blockOrigin(j)
        const sx = bx + 3.5 + rand() * 2
        const sz = bz + 3.5 + rand() * 2
        const rot = Math.floor(rand() * 4) * (Math.PI / 2)
        const g = new THREE.Group()
        const body = new THREE.Mesh(bodyGeom, new THREE.MeshStandardMaterial({ color: palette[placed % palette.length], roughness: 0.7 }))
        body.position.y = 1.0
        body.castShadow = true
        const counter = new THREE.Mesh(counterGeom, new THREE.MeshBasicMaterial({ color: 0xffd9a0 }))
        counter.position.set(0, 1.15, 0.81)
        const awning = new THREE.Mesh(awningGeom, new THREE.MeshStandardMaterial({ color: placed % 2 ? 0xf4e3c1 : 0xd94f3d, roughness: 0.85, side: THREE.DoubleSide }))
        awning.position.set(0, 2.35, 0.75)
        awning.rotation.x = -0.5
        const name = names[placed % names.length]
        const signTex = (() => {
          const c = document.createElement('canvas')
          c.width = 256
          c.height = 56
          const g2 = c.getContext('2d')
          if (!g2) return null
          g2.fillStyle = '#0b0f1a'
          g2.fillRect(0, 0, 256, 56)
          g2.font = 'bold 34px Arial'
          g2.textAlign = 'center'
          g2.textBaseline = 'middle'
          g2.shadowColor = '#ffcf6e'
          g2.shadowBlur = 14
          g2.fillStyle = '#ffe1a1'
          g2.fillText(name, 128, 30)
          const t = new THREE.CanvasTexture(c)
          t.anisotropy = 4
          return t
        })()
        const sign = new THREE.Mesh(signGeom, new THREE.MeshBasicMaterial({ map: signTex ?? undefined, color: signTex ? 0xffffff : 0xffe1a1 }))
        sign.position.set(0, 2.2, 0.84)
        g.add(body, counter, awning, sign)
        g.position.set(sx, 0, sz)
        g.rotation.y = rot
        this.scene.add(g)
        const pad = 1.6
        this.buildings.push({ minX: sx - pad, maxX: sx + pad, minZ: sz - pad, maxZ: sz + pad })
        this.stallSpots.push(sx, sz)
        // warm counter glow + rising steam plumes
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffb066, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }))
        glow.position.set(sx, 2.4, sz)
        glow.scale.setScalar(2.6)
        this.scene.add(glow)
        for (let si = 0; si < 3; si++) {
          const sm = new THREE.SpriteMaterial({ map: glowTex, color: 0xd8f0ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
          const steam = new THREE.Sprite(sm)
          steam.position.set(sx + (rand() - 0.5) * 0.6, 2.1, sz + (rand() - 0.5) * 0.6)
          steam.scale.setScalar(0.9)
          this.scene.add(steam)
          this.stallSteam.push({ sprite: steam, phase: rand() * Math.PI * 2, base: new THREE.Vector3(steam.position.x, 2.1, steam.position.z) })
        }
        placed++
      }
    }
  }

  /** Animated seagulls circling over the water and the sand — the beach finally feels alive. */
  private genBeachLife(rand: () => number): void {
    const geom = new THREE.BufferGeometry()
    const verts = new Float32Array([
      0, 0, 0.28, -1.05, 0.12, -0.12, 0, 0, -0.3,
      0, 0, 0.28, 0, 0, -0.3, 1.05, 0.12, -0.12,
    ])
    geom.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    geom.computeVertexNormals()
    const mat = new THREE.MeshBasicMaterial({ color: 0xe9ecf2, side: THREE.DoubleSide })
    const COUNT_BIRDS = 22
    this.birdMesh = new THREE.InstancedMesh(geom, mat, COUNT_BIRDS)
    this.birdMesh.frustumCulled = false
    this.birdData = []
    for (let k = 0; k < COUNT_BIRDS; k++) {
      const overWater = k < 15
      this.birdData.push({
        cx: (rand() - 0.5) * HALF * 1.6,
        cz: (rand() - 0.5) * HALF * 1.6,
        r: overWater ? HALF + 50 + rand() * 14 : HALF + 16 + rand() * 16,
        speed: 0.25 + rand() * 0.3,
        phase: rand() * Math.PI * 2,
        h: 11 + rand() * 12,
        dir: rand() > 0.5 ? 1 : -1,
        flap: 5 + rand() * 4,
      })
    }
    this.scene.add(this.birdMesh)

    // ================= BUSY BEACH =================
    // Sunbathers, couples, beach-ball games, campfire guitar circles and a
    // promenade food row — the shore should feel like a real evening beach.
    const charKeys = Object.keys(this.assets.chars)
    if (charKeys.length > 0) {
      // Bright beach-wear palette (vs the muted street tints)
      const swimTints = [0xe8a2b4, 0x9fd8e8, 0xf6e2a8, 0xffd166, 0xef8354, 0xb8f2e6, 0xf9f6f0, 0xff9e7d, 0xa0c4ff, 0xfdffb6]
      const makeBeacher = (px: number, pz: number, rotY: number, lie: boolean): THREE.Group => {
        const key = charKeys[Math.floor(rand() * charKeys.length)]
        const { obj, clips } = cloneCharacter(this.assets, key)
        const bb = new THREE.Box3().setFromObject(obj)
        const h = bb.max.y - bb.min.y
        const s = h > 0.01 ? (1.6 + rand() * 0.28) / h : 1
        obj.scale.setScalar(s)
        const tint = new THREE.Color(swimTints[Math.floor(rand() * swimTints.length)])
        tint.multiplyScalar(0.85 + rand() * 0.3)
        obj.traverse((o) => {
          const m = o as THREE.Mesh
          if (m.isMesh) {
            const mat = (m.material as THREE.MeshStandardMaterial).clone()
            mat.color = tint.clone()
            m.material = mat
          }
        })
        obj.position.y = -bb.min.y * s
        const mixer = new THREE.AnimationMixer(obj)
        const idleClip = clips.find((c) => /idle|stand/i.test(c.name)) ?? clips[0]
        const action = mixer.clipAction(idleClip)
        action.play()
        action.timeScale = lie ? 0.25 + rand() * 0.2 : 0.85 + rand() * 0.35 // slow breathing when lying
        const wrap = new THREE.Group()
        wrap.add(obj)
        wrap.position.set(px, 0, pz)
        wrap.rotation.y = rotY
        if (lie) {
          // On their back on a towel, face to the sky
          wrap.rotation.x = -Math.PI / 2
          wrap.position.y = 0.17
        }
        this.scene.add(wrap)
        this.idlers.push({ mesh: wrap, mixer, baseY: wrap.position.y })
        return wrap
      }
      const towelG = new THREE.BoxGeometry(1.15, 0.05, 2.05)
      const towelCols = [0xff6b9d, 0x4ecdc4, 0xffe66d, 0x95e1d3, 0xf38181, 0xa8e6cf, 0xff9e7d, 0xa0c4ff]
      const putTowel = (px: number, pz: number, rotY: number, wide = false): void => {
        const t = new THREE.Mesh(towelG, new THREE.MeshStandardMaterial({ color: towelCols[Math.floor(rand() * towelCols.length)], roughness: 0.95 }))
        t.scale.x = wide ? 1.9 : 1
        t.position.set(px, 0.08, pz)
        t.rotation.y = rotY
        this.scene.add(t)
      }
      // Random free sand spot, any side of the ring, away from the shore spawn
      const sandSpot = (): { x: number; z: number } => {
        for (let tries = 0; tries < 20; tries++) {
          const side = Math.floor(rand() * 4)
          const along = (rand() * 2 - 1) * (HALF - 2)
          const out = HALF + 10 + rand() * 30
          const x = side === 2 ? -out : side === 3 ? out : along
          const z = side === 0 ? -out : side === 1 ? out : along
          if ((x - 8) ** 2 + (z - 226) ** 2 < 20 * 20) continue
          return { x, z }
        }
        return { x: 0, z: -(HALF + 20) }
      }
      // --- Sunbathers lying on towels (singles) ---
      for (let i = 0; i < 14; i++) {
        const { x, z } = sandSpot()
        const rotY = rand() * Math.PI * 2
        putTowel(x, z, rotY)
        makeBeacher(x, z, rotY + Math.PI, true)
      }
      // --- Couples sharing a wide towel ---
      for (let i = 0; i < 5; i++) {
        const { x, z } = sandSpot()
        const rotY = rand() * Math.PI * 2
        putTowel(x, z, rotY, true)
        const ox = Math.cos(rotY) * 0.62
        const oz = -Math.sin(rotY) * 0.62
        makeBeacher(x + ox, z + oz, rotY + Math.PI, true)
        makeBeacher(x - ox, z - oz, rotY + Math.PI + (rand() - 0.5) * 0.5, true)
      }
      // --- Beach-ball games: two players facing off, ball arcs between them ---
      const ballTex = (() => {
        const c = document.createElement('canvas')
        c.width = c.height = 64
        const g = c.getContext('2d')
        if (!g) return null
        const cols = ['#ef4444', '#f8fafc', '#3b82f6', '#f8fafc', '#facc15', '#f8fafc']
        cols.forEach((col, i) => { g.fillStyle = col; g.fillRect((i * 64) / cols.length, 0, 64 / cols.length + 1, 64) })
        const t = new THREE.CanvasTexture(c)
        return t
      })()
      const ballGeom = new THREE.SphereGeometry(0.34, 18, 14)
      for (let i = 0; i < 4; i++) {
        const { x, z } = sandSpot()
        const ang = rand() * Math.PI * 2
        const dx = Math.cos(ang) * 2.3
        const dz = Math.sin(ang) * 2.3
        makeBeacher(x + dx, z + dz, Math.atan2(-dx, -dz), false)
        makeBeacher(x - dx, z - dz, Math.atan2(dx, dz), false)
        const ball = new THREE.Mesh(ballGeom, new THREE.MeshStandardMaterial({ map: ballTex ?? undefined, color: 0xffffff, roughness: 0.5 }))
        this.scene.add(ball)
        this.beachBalls.push({
          mesh: ball,
          a: new THREE.Vector3(x + dx, 1.15, z + dz),
          b: new THREE.Vector3(x - dx, 1.15, z - dz),
          phase: rand(),
          dur: 1.5 + rand() * 0.5,
        })
      }
      // --- Campfire guitar circles: logs, firelight, a guitarist, friends around ---
      const logGeom = new THREE.CylinderGeometry(0.09, 0.11, 0.9, 6)
      const logMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9 })
      const stoneGeom = new THREE.SphereGeometry(0.14, 7, 5)
      const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8d8d94, roughness: 0.95 })
      const guitarBody = new THREE.BoxGeometry(0.36, 0.46, 0.1)
      const guitarNeck = new THREE.BoxGeometry(0.07, 0.55, 0.05)
      const guitarMat = new THREE.MeshStandardMaterial({ color: 0x9c6642, roughness: 0.55 })
      const guitarDark = new THREE.MeshStandardMaterial({ color: 0x4a3220, roughness: 0.6 })
      const glowTex = makeGlowTexture()
      for (let i = 0; i < 3; i++) {
        const { x, z } = sandSpot()
        // fire pit: crossed logs + stone ring + flickering light
        for (let l = 0; l < 3; l++) {
          const log = new THREE.Mesh(logGeom, logMat)
          log.position.set(x, 0.12 + l * 0.07, z)
          log.rotation.set(Math.PI / 2, 0, (l * Math.PI) / 3)
          this.scene.add(log)
        }
        for (let sN = 0; sN < 7; sN++) {
          const a = (sN / 7) * Math.PI * 2
          const st = new THREE.Mesh(stoneGeom, stoneMat)
          st.position.set(x + Math.cos(a) * 0.75, 0.08, z + Math.sin(a) * 0.75)
          this.scene.add(st)
        }
        const fire = new THREE.PointLight(0xff8a3d, 7, 13, 2)
        fire.position.set(x, 0.8, z)
        if (!this.lowPower) this.scene.add(fire)
        const fglow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff9a4d, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }))
        fglow.position.set(x, 0.55, z)
        fglow.scale.setScalar(1.6)
        this.scene.add(fglow)
        this.fireLights.push({ light: fire, phase: rand() * Math.PI * 2, glow: fglow })
        // friends around the fire; one holds the guitar
        const n = 4 + Math.floor(rand() * 2)
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + rand() * 0.3
          const px = x + Math.cos(a) * 1.9
          const pz = z + Math.sin(a) * 1.9
          const w = makeBeacher(px, pz, -a - Math.PI / 2, false)
          if (k === 0) {
            // guitar held across the body
            const gtr = new THREE.Group()
            const body = new THREE.Mesh(guitarBody, guitarMat)
            const neck = new THREE.Mesh(guitarNeck, guitarDark)
            neck.position.set(-0.28, 0.28, 0)
            neck.rotation.z = 0.7
            gtr.add(body, neck)
            gtr.position.set(0.05, 0.85, 0.34)
            gtr.rotation.set(0.15, 0, -0.25)
            w.add(gtr)
          }
        }
      }
      // --- Promenade food row: 3 glowing stalls on the sand, vendors + queues ---
      const stallRow: [number, number][] = [[60, 228], [110, 231], [160, 228]]
      const counterG = new THREE.BoxGeometry(2.6, 1.0, 1.0)
      const awnG = new THREE.BoxGeometry(3.2, 0.08, 1.6)
      const postG = new THREE.CylinderGeometry(0.05, 0.05, 2.3, 6)
      const bulbG = new THREE.SphereGeometry(0.06, 6, 5)
      const stallCols = [0xff5964, 0x35c4b5, 0xffb627]
      stallRow.forEach(([sx, sz], si) => {
        const col = stallCols[si % stallCols.length]
        const counter = new THREE.Mesh(counterG, new THREE.MeshStandardMaterial({ color: 0x3a3f4d, roughness: 0.8 }))
        counter.position.set(sx, 0.5, sz)
        this.scene.add(counter)
        const awn = new THREE.Mesh(awnG, new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, emissive: col, emissiveIntensity: 0.25 }))
        awn.position.set(sx, 2.35, sz + 0.15)
        awn.rotation.x = 0.18
        this.scene.add(awn)
        for (const pxo of [-1.45, 1.45]) {
          const post = new THREE.Mesh(postG, new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.7 }))
          post.position.set(sx + pxo, 1.15, sz + 0.75)
          this.scene.add(post)
        }
        // string of warm bulbs under the awning edge
        for (let bN = 0; bN < 7; bN++) {
          const bulb = new THREE.Mesh(bulbG, new THREE.MeshBasicMaterial({ color: 0xffd9a0 }))
          bulb.position.set(sx - 1.35 + bN * 0.45, 2.18 - Math.sin((bN / 6) * Math.PI) * 0.1, sz + 0.85)
          this.scene.add(bulb)
        }
        const stallLight = new THREE.PointLight(col, 5, 9, 2)
        stallLight.position.set(sx, 2.0, sz + 0.8)
        if (!this.lowPower) this.scene.add(stallLight)
        // vendor behind the counter, customers in front
        makeBeacher(sx, sz - 1.05, 0, false)
        const nc = 1 + Math.floor(rand() * 2)
        for (let cN = 0; cN < nc; cN++) makeBeacher(sx - 0.7 + cN * 1.3, sz + 1.5, Math.PI, false)
        // steam plume, animated by the existing stall-steam loop
        const sm = new THREE.SpriteMaterial({ map: glowTex, color: 0xd8f0ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
        const steam = new THREE.Sprite(sm)
        steam.position.set(sx + 0.6, 2.1, sz)
        steam.scale.setScalar(1.1)
        this.scene.add(steam)
        this.stallSteam.push({ sprite: steam, phase: rand() * Math.PI * 2, base: new THREE.Vector3(sx + 0.6, 2.1, sz) })
        // cars can drive on the sand — make the counter a real obstacle
        this.buildings.push({ minX: sx - 1.3, maxX: sx + 1.3, minZ: sz - 0.5, maxZ: sz + 0.5 })
      })
    }
  }

  private updateBirds(dt: number): void {
    void dt
    if (!this.birdMesh) return
    for (let k = 0; k < this.birdData.length; k++) {
      const b = this.birdData[k]
      const a = b.phase + this.time * b.speed * b.dir
      this.birdDummy.position.set(
        b.cx + Math.cos(a) * b.r,
        b.h + Math.sin(this.time * 0.7 + b.phase) * 1.6,
        b.cz + Math.sin(a) * b.r
      )
      this.birdDummy.rotation.set(0, -a - (b.dir > 0 ? 0 : Math.PI), Math.sin(this.time * b.flap + b.phase) * 0.38)
      this.birdDummy.updateMatrix()
      this.birdMesh.setMatrixAt(k, this.birdDummy.matrix)
    }
    this.birdMesh.instanceMatrix.needsUpdate = true
  }

  /** Ocean surf: advance the water-swell clock and roll the foam bands up the sand. */
  private updateWaves(): void {
    const timeU = this.scene.userData.waterTime as { value: number } | undefined
    if (timeU) timeU.value = this.time
    const bands = this.scene.userData.foamBands as THREE.Mesh[] | undefined
    if (bands) {
      for (const band of bands) {
        const p = (this.time * 0.12 + (band.userData.phase as number)) % 1
        const s = 1 - p * 0.045
        band.scale.set(s, s, 1)
        // foamNight: theme-driven boost so surf reads brighter after dark
        ;(band.material as THREE.MeshBasicMaterial).opacity = Math.sin(p * Math.PI) * 0.3 * this.foamNight
      }
    }
    // Moonlight track: gentle vertical shimmer
    if (this.moonTrackMat && this.moonTrackMat.map) {
      this.moonTrackMat.map.offset.y = (this.time * 0.013) % 1
    }
  }

  // =============== CAR ===============
  private buildCar(): void {
    const g = this.car
    // Exhaust flames + brake-light strip live outside the model (game-driven FX)
    this.flameL.position.set(-0.55, 0.35, -2.85)
    this.flameR.position.set(0.55, 0.35, -2.85)
    this.flameL.visible = false
    this.flameR.visible = false
    const tail = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.16, 0.08), this.taillightMat)
    tail.position.set(0, 0.62, -2.29)
    g.add(tail, this.flameL, this.flameR)

    // Underglow disc
    const glowDisc = new THREE.Mesh(
      new THREE.CircleGeometry(2.4, 24),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.34, blending: THREE.AdditiveBlending, depthWrite: false })
    )
    glowDisc.rotation.x = -Math.PI / 2
    glowDisc.position.y = 0.05
    g.add(glowDisc)
    this.glowDisc = glowDisc

    // Neon rocker strips — thin glow bars along both sills (Need-for-Speed style).
    // Colored from the skin's glow in applyLoadout().
    const stripGeom = new THREE.BoxGeometry(0.05, 0.07, 3.6)
    for (const side of [-1, 1]) {
      const strip = new THREE.Mesh(
        stripGeom,
        new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
      )
      strip.position.set(side * 1.06, 0.22, -0.1)
      g.add(strip)
      this.neonStrips.push(strip)
    }

    // Headlight pools — warm light thrown on the tarmac ahead of the car
    const poolGeom = new THREE.PlaneGeometry(3.0, 5.2)
    const poolMat = new THREE.MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false })
    const poolL = new THREE.Mesh(poolGeom, poolMat)
    poolL.position.set(-0.55, 0.045, 3.2)
    poolL.rotation.x = -Math.PI / 2
    const poolR = new THREE.Mesh(poolGeom, poolMat)
    poolR.position.set(0.55, 0.045, 3.2)
    poolR.rotation.x = -Math.PI / 2
    g.add(poolL, poolR)

    g.add(this.glowLight)
    this.glowLight.position.set(0, 0.3, 0)
    this.scene.add(g)
  }

  private glowDisc: THREE.Mesh | null = null
  private neonStrips: THREE.Mesh[] = []
  private carModel: THREE.Group | null = null

  /** Swap the player car body for the skin's real 3D model (Kenney car kit). */
  private applyCarModel(): void {
    const skin = getSkin(this.hooks.getSave().skin)
    const model = skin.model ?? 'sedan-sports'
    if (this.carModel) {
      this.car.remove(this.carModel)
      this.carModel = null
    }
    const cm = cloneCar(this.assets, model, skin.body)
    // Normalize every model to the same road footprint (~4.4m), wheels on ground
    const bb = new THREE.Box3().setFromObject(cm)
    const len = bb.max.z - bb.min.z
    const s = len > 0.01 ? 4.4 / len : 1
    cm.scale.setScalar(s)
    cm.position.y = -bb.min.y * s
    this.car.add(cm)
    cm.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) m.castShadow = true
    })
    this.carModel = cm
  }

  // =============== SHARDS / DRONES / TRAFFIC ===============
  private spawnShards(): void {
    const rand = seededRand(9001)
    const geom = new THREE.OctahedronGeometry(0.9)
    const mat = new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x22d3ee, emissiveIntensity: 1.6, roughness: 0.2 })
    for (let k = 0; k < TOTAL_SHARDS; k++) {
      const p = roadPoint(rand)
      const mesh = new THREE.Mesh(geom, mat)
      mesh.position.set(p.x + (rand() - 0.5) * 6, 1.4, p.z + (rand() - 0.5) * 6)
      this.scene.add(mesh)
      this.shards.push({ id: `shard-${k}`, mesh, taken: false })
    }
  }

  private spawnDrones(): void {
    const rand = seededRand(555)
    for (let k = 0; k < 6; k++) {
      const g = new THREE.Group()
      const body = new THREE.Mesh(
        new THREE.SphereGeometry(0.9, 12, 10),
        new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.4, metalness: 0.7 })
      )
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3355 }))
      eye.position.set(0, -0.15, 0.7)
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.09, 8, 24), new THREE.MeshBasicMaterial({ color: 0xff3355 }))
      ring.rotation.x = Math.PI / 2
      const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.8, 4), new THREE.MeshBasicMaterial({ color: 0x8899aa }))
      antenna.position.y = 1.1
      g.add(body, eye, ring, antenna)
      const p = roadPoint(rand)
      g.position.set(p.x, 2.2, p.z)
      this.scene.add(g)
      this.drones.push({ mesh: g, pos: g.position.clone(), vel: new THREE.Vector3(), wp: roadPoint(rand), bob: rand() * 10 })
    }
  }

  private spawnTraffic(): void {
    // v2.1 — every city has its own fleet; only the active city's cars drive.
    for (const z of WORLD_ZONES) this.spawnZoneTraffic(z)
  }

  /** One city's fleet: London's double-deckers + black cabs, Mumbai's
      tuk-tuks, New York's yellow cabs — each zone's mix and colours. */
  private spawnZoneTraffic(zone: WorldZone): void {
    const arch = zone.arch
    if (!arch) return
    const zi = WORLD_ZONES.findIndex((z) => z.id === zone.id)
    const rand = seededRand(31415 + zi * 131)
    const styles = arch.traffic
    const trafficCount = this.lowPower ? Math.min(styles.length, 10) : (arch.trafficCount ?? styles.length)
    for (let k = 0; k < trafficCount; k++) {
      const style = styles[k % styles.length]
      const palette = arch.trafficColors[style] ?? [0x8d99ae]
      const g = this.makeTrafficCar(style, palette[Math.floor(rand() * palette.length)])
      const axis: 'x' | 'z' = rand() > 0.5 ? 'x' : 'z'
      const laneIdx = Math.floor(rand() * (N + 1))
      const lane = -HALF + ROAD / 2 + laneIdx * CELL + (rand() > 0.5 ? 2.6 : -2.6)
      const dir: 1 | -1 = rand() > 0.5 ? 1 : -1
      const along = (rand() * 2 - 1) * HALF
      if (axis === 'x') {
        g.position.set(along, 0, lane)
        g.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2
      } else {
        g.position.set(lane, 0, along)
        g.rotation.y = dir > 0 ? 0 : Math.PI
      }
      g.visible = false
      this.scene.add(g)
      this.traffic.push({ mesh: g, axis, lane, dir, speed: 0, cruise: 8 + rand() * 4, nmCooldown: 0, yieldT: 0, zone: zone.id })
    }
  }

  /** Mumbai icon: a colourful auto-rickshaw (3-wheeler, canopy + long tail). */
  private makeTukTuk(color: number): THREE.Group {
    const g = new THREE.Group()
    const body = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.2 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.9 })
    const glass = new THREE.MeshStandardMaterial({ color: 0xbfe3f5, roughness: 0.2, metalness: 0.6, emissive: 0x87a8bb, emissiveIntensity: 0.3 })
    // cabin
    const lower = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.7, 2.2), body)
    lower.position.set(0, 0.6, -0.3)
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 2.0), body)
    canopy.position.set(0, 1.2, -0.3)
    const wind = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.42, 0.1), glass)
    wind.position.set(0, 0.95, 0.75)
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.8, 0.1), dark)
    back.position.set(0, 0.85, -1.45)
    g.add(lower, canopy, wind, back)
    // tail platform (where the bags ride)
    const tail = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.18, 0.9), dark)
    tail.position.set(0, 0.52, 1.4)
    g.add(tail)
    const wheelGeom = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 10)
    wheelGeom.rotateZ(Math.PI / 2)
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.9 })
    for (const [wx, wz] of [[-0.85, 0.7], [0.85, 0.7], [0, -1.35]] as const) {
      const w = new THREE.Mesh(wheelGeom, wheelMat)
      w.position.set(wx, 0.42, wz)
      g.add(w)
    }
    // night strips — headlight + tail
    const hl = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.14, 0.06), new THREE.MeshBasicMaterial({ color: 0xfff2cc, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95, depthWrite: false }))
    hl.position.set(0, 0.85, 0.78)
    const tl = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.14, 0.06), new THREE.MeshBasicMaterial({ color: 0xff2d44, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95, depthWrite: false }))
    tl.position.set(0, 0.8, -1.5)
    g.add(hl, tl)
    g.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) m.castShadow = true
    })
    return g
  }

  /** London icon: a procedural red double-decker bus (no GLB needed). */
  private makeDoubleDecker(): THREE.Group {
    const g = new THREE.Group()
    const red = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.45, metalness: 0.25 })
    const glass = new THREE.MeshStandardMaterial({ color: 0xbfe3f5, roughness: 0.2, metalness: 0.6, emissive: 0x87a8bb, emissiveIntensity: 0.35 })
    const lower = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.5, 7.2), red)
    lower.position.y = 1.15
    const upper = new THREE.Mesh(new THREE.BoxGeometry(2.35, 1.45, 6.9), red)
    upper.position.y = 2.65
    const winL = new THREE.Mesh(new THREE.BoxGeometry(2.46, 0.55, 6.6), glass)
    winL.position.y = 1.35
    const winU = new THREE.Mesh(new THREE.BoxGeometry(2.41, 0.55, 6.5), glass)
    winU.position.y = 2.75
    g.add(lower, upper, winL, winU)
    const wheelGeom = new THREE.CylinderGeometry(0.45, 0.45, 0.35, 10)
    wheelGeom.rotateZ(Math.PI / 2)
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.9 })
    for (const [wx, wz] of [[-1.1, 2.3], [1.1, 2.3], [-1.1, -2.3], [1.1, -2.3]] as const) {
      const w = new THREE.Mesh(wheelGeom, wheelMat)
      w.position.set(wx, 0.45, wz)
      g.add(w)
    }
    // Light strips so it reads at night like the rest of traffic
    const hl = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.14, 0.06), new THREE.MeshBasicMaterial({ color: 0xfff2cc, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95, depthWrite: false }))
    hl.position.set(0, 1.0, 3.63)
    const tl = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.14, 0.06), new THREE.MeshBasicMaterial({ color: 0xff2d44, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95, depthWrite: false }))
    tl.position.set(0, 1.0, -3.63)
    g.add(hl, tl)
    g.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) m.castShadow = true
    })
    return g
  }

  private makeTrafficCar(style: string, color: number): THREE.Group {
    if (style === 'bus') return this.makeDoubleDecker()
    if (style === 'tuk') return this.makeTukTuk(color)
    const modelByStyle: Record<string, string> = {
      sedan: 'sedan',
      hatch: 'hatchback-sports',
      van: 'van',
      taxi: 'taxi',
      sport: 'sedan-sports',
    }
    const model = modelByStyle[style] ?? 'sedan'
    // The taxi/police palettes are baked into their models — don't tint those
    const g = cloneCar(this.assets, model, style === 'taxi' ? undefined : color)
    // Normalize each model to a sensible road length, wheels on the ground
    const bb = new THREE.Box3().setFromObject(g)
    const len = bb.max.z - bb.min.z
    const target = style === 'van' ? 4.7 : style === 'hatch' ? 3.8 : 4.3
    const s = len > 0.01 ? target / len : 1
    g.scale.setScalar(s)
    g.position.y = -bb.min.y * s
    // Headlight + taillight glow strips (positioned after scaling, parent space).
    // Additive materials so they BLOOM against the night instead of reading flat.
    const hlMat = new THREE.MeshBasicMaterial({ color: 0xfff2cc, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95, depthWrite: false })
    const tlMat = new THREE.MeshBasicMaterial({ color: 0xff2d44, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95, depthWrite: false })
    const hl = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 0.06), hlMat)
    hl.position.set(0, bb.max.y * s * 0.62, bb.max.z * s + 0.03)
    const tl = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 0.06), tlMat)
    tl.position.set(0, bb.max.y * s * 0.62, bb.min.z * s - 0.03)
    g.add(hl, tl)
    // Headlight pool — warm light thrown on the tarmac ahead (same trick as the player car)
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 4.6),
      new THREE.MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false })
    )
    pool.rotation.x = -Math.PI / 2
    pool.position.set(0, 0.05, bb.max.z * s + 2.1)
    // Tail glow — soft red wash behind so brake lights read from a distance
    const tailGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, 1.1),
      new THREE.MeshBasicMaterial({ color: 0xff2244, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false })
    )
    tailGlow.position.set(0, bb.max.y * s * 0.55, bb.min.z * s - 0.12)
    tailGlow.rotation.y = Math.PI // face rearward so the wash reads from behind
    g.add(pool, tailGlow)
    return g
  }

  // =============== LOADOUT / THEME ===============
  applyLoadout(): void {
    const save = this.hooks.getSave()
    const skin = getSkin(save.skin)
    const theme = getTheme(save.theme)
    this.bodyMat.color.setHex(skin.body)
    this.baseBodyColor.setHex(skin.body)
    this.applyDamageLook() // re-apply fade if the car is already dented
    this.applyCarModel()
    this.glowLight.color.setHex(skin.glow)
    if (this.glowDisc) {
      ;(this.glowDisc.material as THREE.MeshBasicMaterial).color.setHex(skin.glow)
    }
    for (const strip of this.neonStrips) {
      ;(strip.material as THREE.MeshBasicMaterial).color.setHex(skin.glow)
    }
    ;(this.trailLine.material as THREE.LineBasicMaterial).color.setHex(skin.glow)
    this.applyTheme(theme)
    // Move headlights into the car group once
    if (this.headL.parent !== this.car) {
      this.car.add(this.headL, this.headL.target, this.headR, this.headR.target)
      this.headL.position.set(-0.7, 0.7, 2.2)
      this.headR.position.set(0.7, 0.7, 2.2)
      this.headL.target.position.set(-0.7, 0.2, 30)
      this.headR.target.position.set(0.7, 0.2, 30)
      this.car.add(this.headSpot, this.headSpot.target)
      this.headSpot.position.set(0, 1.05, 2.3)
      this.headSpot.target.position.set(0, 0.1, 30)
    }
  }

  // Smooth theme transitions: every numeric/color theme param lerps over ~9s
  // instead of snapping; the sky repaints through a shared transition canvas.
  private themeFrom: ThemeMix | null = null
  private themeTo: ThemeMix | null = null
  private themeBlend = 1
  private themeBlendDur = 9
  private pendingRain = false
  private targetTheme: ReturnType<typeof getTheme> | null = null
  private themeSkyCanvas: HTMLCanvasElement | null = null
  private themeSkyTex: THREE.CanvasTexture | null = null

  private applyTheme(t: ReturnType<typeof getTheme>, dur = 9): void {
    const to = this.themeMixOf(t)
    if (!this.themeTo) {
      // First apply after load: snap straight to the theme.
      this.themeFrom = to
      this.themeTo = to
      this.themeBlend = 1
      this.themeBlendDur = dur
      this.targetTheme = t
      this.applyMix(to)
      this.scene.background = this.skyBackground(t)
      if (t.rain && !this.rain) this.setupRain()
      if (this.rain) this.rain.visible = t.rain
      this.synth.setRain(t.rain ? 1 : 0)
      return
    }
    // Begin a smooth blend FROM wherever we are right now (mid-blend safe).
    this.themeFrom = this.lerpMix(this.themeFrom ?? to, this.themeTo, this.themeBlend)
    this.themeTo = to
    this.themeBlend = 0
    this.themeBlendDur = dur
    this.pendingRain = t.rain
    this.targetTheme = t
    if (t.rain && !this.rain) this.setupRain()
  }

  private updateTheme(dt: number): void {
    if (this.themeBlend >= 1 || !this.themeFrom || !this.themeTo) return
    this.themeBlend = Math.min(1, this.themeBlend + dt / this.themeBlendDur)
    const k = this.themeBlend
    const m = this.lerpMix(this.themeFrom, this.themeTo, k)
    this.applyMix(m)
    this.paintTransitionSky(m)
    // Rain is binary: switch it at the midpoint of the transition
    if (this.rain) this.rain.visible = this.pendingRain ? k > 0.5 : k < 0.5
    this.synth.setRain(this.rain && this.rain.visible ? 1 : 0)
    if (this.themeBlend >= 1 && this.targetTheme) {
      this.scene.background = this.skyBackground(this.targetTheme)
      if (this.rain) this.rain.visible = this.pendingRain
      this.synth.setRain(this.pendingRain ? 1 : 0)
      // The blend just overwrote fog/lane/walk with theme values — hand the
      // air back to the city you're currently in.
      const z = WORLD_ZONES.find((wz) => wz.id === this.lastZoneId)
      if (z) this.applyZoneAtmosphere(z)
    }
  }

  private themeMixOf(t: ReturnType<typeof getTheme>): ThemeMix {
    const day = t.id === 'day'
    const dayGolden = day || t.id === 'golden'
    return {
      skyTop: SKY_TOPS[t.id] ?? 0x060a16,
      sky: t.sky,
      fog: t.fog,
      fogDensity: t.fogDensity,
      ambient: t.ambient,
      ambientI: t.ambientIntensity,
      moon: t.moon,
      moonI: t.moonIntensity,
      ground: t.ground,
      water: t.water,
      // Facade self-glow pulled back (0.38 → 0.24): the full-texture emissive
      // was washing every building back to beige at night, hiding the slate
      // district tints. Window pixels are the brightest in the texture, so
      // they still glow through at the lower intensity.
      cityEm: day ? 0.1 : 0.24,
      skyEm: day ? 0.12 : 0.55,
      headSpot: day ? 0 : 260,
      winColor: day ? 0x46566e : 0xffffff,
      lens: day ? 0x9aa6ad : 0xffe2b0,
      glow: day ? 0 : 0.35,
      track: day ? 0 : t.id === 'golden' ? 0.5 : 0.38,
      foamNight: day ? 1 : 1.9,
      cloudColor: dayGolden ? 0xffffff : t.id === 'sakura' ? 0x5a4a6e : 0x1a2333,
      cloudOpacity: dayGolden ? 0.95 : t.id === 'sakura' ? 0.7 : 0.42,
      // Vibrant Night City: pale cyan-white paint (#E8F0F7) on dark asphalt so
      // markings stay readable at speed; dark paint by day on the light tarmac.
      lane: day ? 0x46536b : 0xe8f0f7,
      // Sidewalks must never merge with the road: clearly lighter blue-grey at
      // night, slightly darker than the sunlit ground by day.
      walk: day ? 0x6b7683 : 0x55616f,
      // Warmer, more present streetlight pools on the night asphalt (#FFC16B).
      pool: day ? 0 : 0.22,
    }
  }

  private lerpMix(a: ThemeMix, b: ThemeMix, k: number): ThemeMix {
    const cl = (x: number, y: number) => this._ca.setHex(x).lerp(this._cb.setHex(y), k).getHex()
    const nm = (x: number, y: number) => x + (y - x) * k
    return {
      skyTop: cl(a.skyTop, b.skyTop), sky: cl(a.sky, b.sky), fog: cl(a.fog, b.fog),
      fogDensity: nm(a.fogDensity, b.fogDensity),
      ambient: cl(a.ambient, b.ambient), ambientI: nm(a.ambientI, b.ambientI),
      moon: cl(a.moon, b.moon), moonI: nm(a.moonI, b.moonI),
      ground: cl(a.ground, b.ground), water: cl(a.water, b.water),
      cityEm: nm(a.cityEm, b.cityEm), skyEm: nm(a.skyEm, b.skyEm),
      headSpot: nm(a.headSpot, b.headSpot), winColor: cl(a.winColor, b.winColor),
      lens: cl(a.lens, b.lens), pool: nm(a.pool, b.pool), glow: nm(a.glow, b.glow),
      track: nm(a.track, b.track), foamNight: nm(a.foamNight, b.foamNight),
      cloudColor: cl(a.cloudColor, b.cloudColor), cloudOpacity: nm(a.cloudOpacity, b.cloudOpacity),
      lane: cl(a.lane, b.lane), walk: cl(a.walk, b.walk),
    }
  }

  private _ca = new THREE.Color()
  private _cb = new THREE.Color()

  /** Push a blended theme mix into every light/material it touches. */
  private applyMix(m: ThemeMix): void {
    if (!this.scene.fog) this.scene.fog = new THREE.FogExp2(m.fog, m.fogDensity)
    else {
      const fog = this.scene.fog as THREE.FogExp2
      fog.color.setHex(m.fog)
      fog.density = m.fogDensity
    }
    this.ambient.color.setHex(m.ambient)
    this.ambient.intensity = m.ambientI
    this.moon.color.setHex(m.moon)
    this.moon.intensity = m.moonI
    if (this.groundMat) this.groundMat.color.setHex(m.ground)
    const wm = this.scene.userData.waterMat as THREE.MeshStandardMaterial | undefined
    if (wm) wm.color.setHex(m.water)
    this.assets.cityMaterial.emissiveIntensity = m.cityEm
    const lamp = this.scene.userData.lampMats as
      | { lens: THREE.MeshBasicMaterial; pool: THREE.MeshBasicMaterial; glow: THREE.PointsMaterial }
      | undefined
    if (lamp) {
      lamp.lens.color.setHex(m.lens)
      lamp.pool.opacity = m.pool
      lamp.glow.opacity = m.glow
    }
    const sk = this.scene.userData.skylineMat as THREE.MeshStandardMaterial | undefined
    if (sk) sk.emissiveIntensity = m.skyEm
    this.headSpot.intensity = m.headSpot
    const winMat = this.scene.userData.winMat as THREE.MeshBasicMaterial | undefined
    if (winMat) winMat.color.setHex(m.winColor)
    if (this.moonTrackMat) this.moonTrackMat.opacity = m.track
    this.foamNight = m.foamNight
    this.cloudMat.color.setHex(m.cloudColor)
    this.cloudMat.opacity = m.cloudOpacity
    if (this.laneMat) this.laneMat.color.setHex(m.lane)
    if (this.walkMat) this.walkMat.color.setHex(m.walk)
  }

  /** Repaint the sky gradient for an in-between theme mix. */
  private paintTransitionSky(m: ThemeMix): void {
    if (!this.themeSkyCanvas) {
      this.themeSkyCanvas = document.createElement('canvas')
      this.themeSkyCanvas.width = 64
      this.themeSkyCanvas.height = 512
      this.themeSkyTex = new THREE.CanvasTexture(this.themeSkyCanvas)
      this.themeSkyTex.colorSpace = THREE.SRGBColorSpace
    }
    const g = this.themeSkyCanvas.getContext('2d')
    if (!g || !this.themeSkyTex) return
    const hex = (v: number) => '#' + v.toString(16).padStart(6, '0')
    const grad = g.createLinearGradient(0, 0, 0, 512)
    grad.addColorStop(0, hex(m.skyTop))
    grad.addColorStop(0.55, hex(m.sky))
    grad.addColorStop(1, hex(m.sky))
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 512)
    this.themeSkyTex.needsUpdate = true
    this.scene.background = this.themeSkyTex
  }

  private setupRain(): void {
    const COUNT = 900
    const geom = new THREE.BufferGeometry()
    const positions = new Float32Array(COUNT * 3)
    this.rainVel = new Float32Array(COUNT)
    const rand = seededRand(31)
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] = (rand() - 0.5) * 160
      positions[i * 3 + 1] = rand() * 60
      positions[i * 3 + 2] = (rand() - 0.5) * 160
      this.rainVel[i] = 38 + rand() * 22
    }
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({ color: 0x9db8ff, size: 0.14, transparent: true, opacity: 0.6 })
    this.rain = new THREE.Points(geom, mat)
    this.rain.frustumCulled = false
    this.scene.add(this.rain)
    // Rain hitting the tarmac: expanding splash rings around the player
    const ringGeom = new THREE.RingGeometry(0.3, 0.55, 14)
    this.rainSplashes = []
    for (let i = 0; i < 26; i++) {
      const sm = new THREE.MeshBasicMaterial({ color: 0x9db8ff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
      const ring = new THREE.Mesh(ringGeom, sm)
      ring.rotation.x = -Math.PI / 2
      ring.visible = false
      this.scene.add(ring)
      this.rainSplashes.push(ring)
    }
    this.splashTimes = new Float32Array(this.rainSplashes.length).fill(-1)
  }

  // =============== INPUT ===============
  /** Unstick: snap the car onto the nearest road center, aligned to the lane. */
  resetToRoad(): void {    const kx = THREE.MathUtils.clamp(Math.round((this.pos.x + HALF - ROAD / 2) / CELL), 0, N)
    const kz = THREE.MathUtils.clamp(Math.round((this.pos.z + HALF - ROAD / 2) / CELL), 0, N)
    const cx = -HALF + ROAD / 2 + kx * CELL
    const cz = -HALF + ROAD / 2 + kz * CELL
    if (Math.abs(this.pos.x - cx) <= Math.abs(this.pos.z - cz)) {
      this.pos.x = cx // snap onto the vertical road
      this.pos.z = THREE.MathUtils.clamp(this.pos.z, -HALF + ROAD, HALF - ROAD)
    } else {
      this.pos.z = cz // snap onto the horizontal road
      this.pos.x = THREE.MathUtils.clamp(this.pos.x, -HALF + ROAD, HALF - ROAD)
    }
    // Face along the road (nearest 90°) so you're never pointed into a wall
    this.heading = Math.round(this.heading / (Math.PI / 2)) * (Math.PI / 2)
    this.vel.set(0, 0, 0)
    this.vy = 0
    this.stuckTime = 0
    this.stuckLatch = 0
    this.hooks.onToast('Back on the road — keep driving!', 'info')
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase()
    this.keys.add(k)
    if (k === 'e' && !this.paused && !this.attract) {
      if (this.nearGarage) this.hooks.onPressE()
      else if (this.nearMarker) {
        if (this.mission) this.hooks.onToast('Finish your current job first', 'warn')
        else this.acceptMarker()
      }
    }
    if (k === ' ' && this.bustedMeter > 0.25 && this.mashCooldown <= 0 && !this.busted && !this.paused && !this.attract) {
      // Struggle free from the patrol grab
      this.bustedMeter = Math.max(0, this.bustedMeter - 0.7)
      this.mashCooldown = 0.16
      this.vel.multiplyScalar(1.05)
      this.synth.checkpoint()
    }
    if (k === 'c' && !this.attract) this.cycleCamera()
    if (k === 'r' && !this.attract && !this.paused) {
      this.resetToRoad()
      this.synth.checkpoint()
    }
    if (k === 'p' && !this.attract && !this.paused) this.hooks.onPhotoToggle?.()
    // 'h' horn: direct blast here (covers touchTap from the mobile HORN button);
    // the keys-set edge detect in updateCar covers held keys — hornCd dedupes.
    if (k === 'h') this.hornBlast()
    if (k === 't' && !this.attract && !this.paused) this.skipTutorial()
    if (['arrowup', 'arrowdown', ' '].includes(k)) e.preventDefault()
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase())
  }

  // Mobile touch overlay: held buttons feed the same key set as the keyboard
  touchDown(k: string): void { this.keys.add(k.toLowerCase()) }
  touchUp(k: string): void { this.keys.delete(k.toLowerCase()) }
  touchReset(): void {
    this.keys.clear()
    this.analogSteer = null
    this.analogThrottle = null
    this.swipeSteer = null
  }
  /** Virtual joystick: steer/throttle in -1..1; pass null to return to digital keys */
  touchAnalog(steer: number | null, throttle: number | null): void {
    this.analogSteer = steer
    this.analogThrottle = throttle
  }
  /** CoD-style swipe steer, VELOCITY-driven like CoD Mobile aiming: the
      steering angle tracks how fast the finger is moving right now, not how
      far it has travelled. A fast flick (~20px/frame) slams to full lock
      instantly; a slow drag eases in; a still finger centers within ~0.15s;
      release straightens immediately. The latest frame delta dominates —
      only a small carry from the previous frame smooths the signal. */
  touchSwipeDelta(dx: number): void {
    this.swipeSteer = THREE.MathUtils.clamp(dx * 0.055 + (this.swipeSteer ?? 0) * 0.35, -1, 1)
  }
  touchSwipeSteer(v: number | null): void {
    this.swipeSteer = v
  }
  /** One-shot action buttons reuse the keyboard handler (E / mash SPACE / C / H / T) */
  touchTap(k: string): void { this.onKeyDown(new KeyboardEvent('keydown', { key: k })) }
  /** React onboarding tour is on screen → hide & freeze the FIRST NIGHT tutorial */
  setOnboardingActive(v: boolean): void { this.onboardingActive = v }
  /** Graduate from the First Night guide for good: damage can WRECK the car
      and the Patrol wakes up (after a 60s grace). Reached three ways: the T
      key (desktop), the guide card's ✕ (touch + desktop), and the 3-minute
      auto-graduation in update() for players who never touch either. Until
      this fires, damage caps at 60% and heat stays off — a player stuck here
      can never see a game over, which read as "the game has no fail state". */
  skipTutorial(auto = false): void {
    const s = this.hooks.getSave()
    if (s.tutorialDone) return
    s.tutorialDone = true
    this.hooks.commit()
    this.heatGraceUntil = this.time + 60
    if (auto) {
      this.hooks.onToast('First Night over — training wheels off. Wrecks and the Patrol are real now.', 'info')
    } else {
      this.hooks.onToast('Tutorial skipped — the whole city is open.', 'info')
      this.hooks.onToast('The Patrol looks the other way for your first 60 seconds.', 'info')
    }
  }
  /** UI platform for wording (toasts): touch vs desktop */
  setUiTouch(v: boolean): void { this.uiTouch = v }

  private bindInput(): void {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    const el = this.renderer.domElement
    el.addEventListener('pointerdown', this.onPhotoPointerDown)
    el.addEventListener('pointermove', this.onPhotoPointerMove)
    el.addEventListener('pointerup', this.onPhotoPointerUp)
    el.addEventListener('pointercancel', this.onPhotoPointerUp)
    el.addEventListener('wheel', this.onPhotoWheel, { passive: false })
  }

  private resize = (): void => {
    // Follow the canvas box, not the window: on phones held in portrait the
    // root div is CSS-rotated into a landscape box, and the renderer must
    // match what the player actually sees.
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    this.renderer.setSize(w, h, false)
    this.composer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  // =============== MAIN LOOP ===============
  // Thermal guard: rAF runs at the display's refresh rate, so on 120/144Hz
  // laptops an uncapped loop does 2× the GPU work of 60fps and cooks the
  // machine. Cap gameplay rendering at 60fps; when the world is frozen
  // (pause menus, overlays) the frozen scene only needs ~5fps to stay alive.
  private frameCapFps = 60
  private lastRenderT = 0
  private loop = (): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    const now = performance.now()
    const cap = this.paused && !this.photoMode ? 5 : this.frameCapFps
    if (now - this.lastRenderT < 1000 / cap - 0.2) return
    this.lastRenderT = now
    this.timer.update()
    let dt = Math.min(this.timer.getDelta(), 0.05)
    // NaN watchdog: a bad physics step must never poison the whole session —
    // reset the car to the garage instead of crashing the audio/render pipeline
    if (!Number.isFinite(this.pos.x + this.pos.z + this.vel.x + this.vel.z)) {
      this.pos.set(this.garagePos.x, 0, this.garagePos.z + 19)
      this.vel.set(0, 0, 0)
      this.heading = Math.PI
    }
    if (!this.paused) {
      if (this.photoMode) this.updatePhotoCamera()
      else {
        // Kill-cam slow motion: the wreck explosion plays at quarter speed so
        // the player SEES the car die before the WRECKED card drops in.
        if (this.slowmoT > 0) { this.slowmoT -= dt; dt *= 0.25 }
        this.time += dt
        this.update(dt)
      }
    }
    // MOB-3: quality watchdog — only counts active frames, only on touch devices,
    // steps down at most one level per 3s window
    if (this.autoQuality && !this.paused) {
      this.fpsAccum += dt
      this.fpsFrames += 1
      this.fpsWindow += dt
      if (this.fpsWindow >= 3) {
        const avg = this.fpsFrames / this.fpsAccum
        this.fpsWindow = 0
        this.fpsAccum = 0
        this.fpsFrames = 0
        if (avg < this.fpsThreshold && this.qualityLevel < 2) {
          this.qualityLevel += 1
          this.applyQuality()
        }
      }
    }
    this.composer.render()
  }

  setAutoQualityEnabled(on: boolean, fpsThreshold = 42): void {
    this.autoQuality = on
    this.fpsThreshold = fpsThreshold
  }

  /** True when WebGL runs on a CPU rasterizer (SwiftShader/llvmpipe) — e.g.
      headless test rigs and locked-down VMs. Those environments can't hold
      full quality, so the caller enables the quality watchdog for them too. */
  isSoftwareRenderer(): boolean {
    try {
      const gl = this.renderer.getContext()
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      const r = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER) || '')
      return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(r)
    } catch {
      return false
    }
  }

  private applyQuality(): void {
    const dpr = window.devicePixelRatio || 1
    const top = this.lowPower ? 1.25 : 1.5
    const pr = this.qualityLevel === 0 ? Math.min(dpr, top) : this.qualityLevel === 1 ? Math.min(dpr, top - 0.25) : this.lowPower ? 0.9 : 1
    this.renderer.setPixelRatio(pr)
    this.composer.setPixelRatio(pr)
    this.resize()
    if (this.qualityLevel >= 2) {
      for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
        if (rt.samples !== 0) { rt.samples = 0; rt.dispose() }
      }
      this.bloomPass.enabled = false
      if (this.moon.shadow.mapSize.x > 1024) {
        this.moon.shadow.mapSize.set(1024, 1024)
        if (this.moon.shadow.map) {
          this.moon.shadow.map.dispose()
          this.moon.shadow.map = null
        }
      }
      this.hooks.onToast('Performance mode: effects reduced to keep the game smooth', 'info')
    } else {
      this.hooks.onToast('Performance mode: display scaled down for smoother play', 'info')
    }
  }

  private update(dt: number): void {
    // First Night auto-graduation: 3 minutes of real driving and the training
    // wheels come off even if the guide was never finished or dismissed —
    // otherwise a player who ignores the card can never WRECK or get BUSTED.
    if (!this.hooks.getSave().tutorialDone && !this.attract && !this.onboardingActive && !this.paused) {
      this.tutDriveTime += dt
      if (this.tutDriveTime > 180) this.skipTutorial(true)
    }
    this.updateCar(dt)
    this.updateTraffic(dt)
    this.updateRoadEvents(dt)
    this.updateCruisers(dt)
    this.updateCred(dt)
    this.updateGhost(dt)
    this.updateContractMarkers()
    this.updateSmoke(dt)
    this.updatePedestrians(dt)
    this.updateBirds(dt)
    this.updateWaves()
    this.updateHarborLife(dt)
    this.updateTrafficLights()
    this.updateTheme(dt)
    this.updateIdlers(dt)
    this.updateBeachLife()
    this.updateCrates(dt)
    this.updatePickups(dt)
    this.updateLandmarks(dt)
    this.updateDistricts(dt)
    this.updateWorldCircuit(dt)
    this.updateDronesAndHeat(dt)
    // Horn & scream cooldowns
    this.hornCd = Math.max(0, this.hornCd - dt)
    this.screamCd = Math.max(0, this.screamCd - dt)
    // Damage smoke: a battered car vents from the hood — grey puffs at 55%+,
    // thick black columns at 80%+, and the wreck keeps burning after the boom.
    if (this.wrecked) {
      this.wreckBurnT -= dt
      if (this.wreckBurnT <= 0) {
        this.wreckBurnT = 0.09
        const a = Math.random() * Math.PI * 2
        const r = Math.random() * 1.4
        this.emitPuff(
          this.pos.x + Math.cos(a) * r, 0.8 + Math.random() * 0.8, this.pos.z + Math.sin(a) * r,
          Math.random() > 0.55 ? 0xff7a1a : 0x1c1c20, 1.6 + Math.random() * 1.2, 1.2, Math.random() > 0.55
        )
      }
      // The wreck rolls to a stop — nothing else drives it
      this.vel.multiplyScalar(Math.max(0, 1 - 2.2 * dt))
    } else if (this.damage > 55) {
      this.damageSmokeT -= dt
      if (this.damageSmokeT <= 0) {
        this.damageSmokeT = this.damage > 80 ? 0.12 : 0.32
        const hx = this.pos.x + Math.sin(this.heading) * 1.8
        const hz = this.pos.z + Math.cos(this.heading) * 1.8
        this.emitPuff(hx, 1.2, hz, this.damage > 80 ? 0x1c1c20 : 0x555a63, this.damage > 80 ? 2.4 : 1.8, 1.5, false)
      }
    }
    this.updateChaseSpotlight()
    // Lighthouse beam sweeps the sea; reaching the island pays a cruise bonus
    if (this.lighthouseBeam) this.lighthouseBeam.rotation.y += dt * 0.7
    this.islandCd = Math.max(0, this.islandCd - dt)
    if (this.islandCd <= 0 && this.pos.z > HALF + 130) {
      const rI = Math.hypot(this.pos.x, this.pos.z - (HALF + 170))
      if (rI < 40) {
        this.islandCd = 45
        this.addChain(150, 'Lighthouse run')
        this.synth.checkpoint()
      }
    }
    // street cred chain decay
    if (this.chainTimer > 0) {
      this.chainTimer -= dt
      if (this.chainTimer <= 0) this.chainCount = 0
    }
    this.updateMission(dt)
    this.updateRide(dt)
    this.updateCamera(dt)
    // Keep the shadow frustum centred on the player as they roam
    this.moon.position.set(this.pos.x - 120, 180, this.pos.z + 60)
    this.moon.target.position.set(this.pos.x, 0, this.pos.z)
    this.updateTrail()
    this.updateRain(dt)
    // Blinking rooftop lights (synced pulse)
    this.blinkMat.color.setHex(Math.sin(this.time * 3.2) > 0 ? 0xff2233 : 0x330a10)
    // shard spin
    for (const s of this.shards) {
      if (!s.taken) {
        s.mesh.rotation.y += dt * 2.2
        s.mesh.position.y = 1.4 + Math.sin(this.time * 2 + s.mesh.position.x) * 0.25
      }
    }
    // beacon pulse
    if (this.markerBeacon.visible) {
      ;(this.markerBeacon.material as THREE.MeshBasicMaterial).opacity = 0.25 + Math.sin(this.time * 4) * 0.12
      this.markerBeacon.rotation.y += dt
    }
    this.hudTimer += dt
    if (this.hudTimer > 0.1) {
      this.hudTimer = 0
      this.pushHud()
      this.drawMinimap()
    }
    const s01 = Math.min(this.vel.length() / (MAX_SPEED * BOOST_MULT), 1)
    this.synth.updateEngine(s01, this.boosting, dt)
    this.synth.updateSiren(this.heat >= 2.5 ? Math.min((this.heat - 2) / 3, 1) : 0, dt)
    // Adaptive soundtrack: patrol heat builds it, a clean getaway settles it
    this.synth.setMusicIntensity(
      this.heat > 0.2 ? Math.min(0.5 + this.heat * 0.12, 1) : this.boosting ? 0.3 : 0,
    )
  }

  // =============== GAMEPAD ===============
  // Standard mapping: left stick steer · RT gas · LT brake · A handbrake ·
  // RB boost · B camera · X horn · Y job board (near garage) · START pause.
  private pollGamepad(): void {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []
    let pad: Gamepad | null = null
    for (const p of pads) if (p && p.connected) { pad = p; break }
    if (!pad) {
      this.padSteer = null
      this.padThrottle = null
      this.padHandbrake = false
      this.padBoost = false
      this.padPrev = []
      return
    }
    if (!this.padAnnounced) {
      this.padAnnounced = true
      this.hooks.onToast('🎮 Gamepad connected — sticks drive, RT gas, A handbrake', 'info')
    }
    const axis = (i: number) => pad.axes[i] ?? 0
    const btn = (i: number) => !!pad.buttons[i]?.pressed
    const steerRaw = axis(0)
    this.padSteer = Math.abs(steerRaw) > 0.14 ? steerRaw : null
    const rt = pad.buttons[7]?.value ?? 0
    const lt = pad.buttons[6]?.value ?? 0
    let thr = rt - lt
    const rStickY = axis(3)
    if (Math.abs(thr) < 0.06 && Math.abs(rStickY) > 0.2) thr = -rStickY
    this.padThrottle = Math.abs(thr) > 0.06 ? THREE.MathUtils.clamp(thr, -1, 1) : null
    this.padHandbrake = btn(0)
    this.padBoost = btn(5) || btn(3) // RB or Y
    // Edge-triggered buttons (compare with previous frame)
    const edge = (i: number) => btn(i) && !this.padPrev[i]
    if (edge(1) && !this.attract) this.cycleCamera() // B: camera
    if (edge(2)) this.hornBlast() // X
    if (edge(9) && !this.attract && !this.paused) this.hooks.onPauseToggle?.() // START
    this.padPrev = pad.buttons.map((b) => b.pressed)
  }

  // =============== PHOTO MODE ===============
  /** Freeze the world and orbit the car. Exits cleanly back to gameplay. */
  setPhotoMode(on: boolean): void {
    if (this.attract) return
    this.photoMode = on
    if (on) {
      this.photoYaw = this.heading + Math.PI
      this.photoPitch = 0.35
      this.photoDist = 9
      this.touchReset()
    }
  }

  private updatePhotoCamera(): void {
    const yaw = this.photoYaw
    const cp = THREE.MathUtils.clamp(this.photoPitch, 0.05, 1.3)
    const target = new THREE.Vector3(this.pos.x, this.pos.y + 1.1, this.pos.z)
    const off = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(cp),
      Math.sin(cp),
      Math.cos(yaw) * Math.cos(cp),
    ).multiplyScalar(this.photoDist)
    this.camera.position.copy(target).add(off)
    this.camera.lookAt(target)
  }

  /** Render one clean frame and return it as a PNG data URL. */
  capturePhoto(): string | null {
    try {
      this.composer.render()
      return this.renderer.domElement.toDataURL('image/png')
    } catch {
      return null
    }
  }

  private onPhotoPointerDown = (e: PointerEvent): void => {
    if (!this.photoMode) return
    this.photoDragging = true
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  private onPhotoPointerMove = (e: PointerEvent): void => {
    if (!this.photoMode || !this.photoDragging) return
    this.photoYaw -= e.movementX * 0.008
    this.photoPitch = THREE.MathUtils.clamp(this.photoPitch + e.movementY * 0.006, 0.05, 1.3)
  }
  private onPhotoPointerUp = (): void => { this.photoDragging = false }
  private onPhotoWheel = (e: WheelEvent): void => {
    if (!this.photoMode) return
    e.preventDefault()
    this.photoDist = THREE.MathUtils.clamp(this.photoDist + e.deltaY * 0.01, 4, 20)
  }

  // =============== CAR PHYSICS ===============
  private updateCar(dt: number): void {
    const save = this.hooks.getSave()
    this.pollGamepad()
    const effThr = this.padThrottle ?? this.analogThrottle // gamepad pedals beat touch joystick
    const up = this.keys.has('w') || this.keys.has('arrowup')
    const down = this.keys.has('s') || this.keys.has('arrowdown')
    const left = this.keys.has('a') || this.keys.has('arrowleft')
    const right = this.keys.has('d') || this.keys.has('arrowright')
    const handbrake = this.keys.has(' ') || this.padHandbrake
    const wantBoost = this.keys.has('shift') || this.padBoost

    // Universal escape hatch: ANY drive input instantly hands the car to the
    // player. If the session is ever left in the cinematic attract orbit with
    // no entry gate on screen (hot reload, restored tab, race in the entry
    // flow), the very first touch on a pedal wakes it — the car can never be
    // a passenger while the player is trying to drive.
    if (this.attract && (up || down || left || right || (effThr !== null && Math.abs(effThr) > 0.12))) {
      this.setAttract(false)
    }

    // Horn: edge-detect on the keys set so keyboard AND touch HORN button both work
    const hornNow = this.keys.has('h')
    if (hornNow && !this.hornHeld && !this.attract) this.hornBlast()
    this.hornHeld = hornNow

    const dir = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))
    let s = this.vel.dot(dir)

    // Performance upgrades from the shop (cash-bought levels, 0-3 each)
    const upg = this.hooks.getSave().upgrades ?? { engine: 0, nitro: 0, tires: 0, armor: 0, suspension: 0, horn: 0 }
    const engineMul = ENGINE_MUL(upg.engine)
    const tiresMul = TIRES_MUL(upg.tires)
    // World Circuit (v2): a broken part carries a real driving penalty until
    // the garage fixes it — a busted engine is slower, a busted tire won't
    // grip, a busted brake line won't stop you.
    const bd = breakdownMuls(save.breakdown)

    this.boosting = false
    if (this.bustedCooldown > 0) {
      this.bustedCooldown -= dt
      if (this.bustedCooldown <= 0) this.busted = false
    }
    const frozen = this.busted || this.attract || this.wrecked

    // Simulator damage: a beaten engine loses power — acceleration and top
    // speed bleed off as damage climbs (never a hard stop, just a sick car).
    const dmgMul = 1 - (this.damage / 100) * 0.35

    if (!frozen && wantBoost && this.boost > 0 && s > 4) {
      this.boosting = true
      this.boost = Math.max(0, this.boost - 32 * NITRO_DRAIN_MUL(upg.nitro) * bd.nitroDrain * dt)
    } else {
      this.boost = Math.min(100, this.boost + 11 * NITRO_REGEN_MUL(upg.nitro) * bd.nitroRegen * dt)
    }

    if (!frozen) {
      const mult = this.boosting ? BOOST_MULT : 1
      // Joystick / gamepad (analog) input replaces the digital pedals when active
      const aThr = effThr
      // The car ALWAYS drives — nothing mechanical ever cuts it. The only
      // things that can halt it are visible on the road: accident scenes and
      // rush-hour jams.
      // Mobile UX: a joystick pushed up means GO, full stop. Small deadzone at
      // rest, then ramp to FULL throttle by half deflection — a casual thumb
      // must never get a crawling car. Keys always work, even if a stale
      // analog value is sitting in the slot (missed pointerup used to
      // deadlock the pedals at 0 — the "car creeps on an open road" bug).
      const aGas = aThr !== null && aThr > 0.12
      const gasPower = aGas ? THREE.MathUtils.clamp((aThr - 0.12) / 0.43, 0, 1) : 0
      const gas = up || aGas
      const braking = down || (aThr !== null && aThr < -0.12)
      if (gas) s += ACCEL * engineMul * dmgMul * bd.accel * (aGas && !up ? gasPower : 1) * mult * dt
      if (braking) s -= (s > 1 ? BRAKE : ACCEL * engineMul * 0.6) * bd.brake * dt
      const maxS = MAX_SPEED * engineMul * dmgMul * mult * bd.top
      s = THREE.MathUtils.clamp(s, -10, maxS)
      // The car's honest top speed (upgrades included, damage excluded) — the
      // Patrol's speeding check is 85% of THIS, so tuning MAX_SPEED can never
      // turn plain cruising into a chase.
      this.curTopSpeed = MAX_SPEED * engineMul
      // Swipe steering is velocity-based (CoD-style): the moment the finger
      // stops moving the steer input bleeds to center in ~0.15s, so the car
      // straightens as soon as the swipe ends — no laggy "drift" feel.
      if (this.swipeSteer !== null) {
        this.swipeSteer *= Math.exp(-dt * 10)
        if (Math.abs(this.swipeSteer) < 0.02) this.swipeSteer = null
      }
      // Joystick tilt keeps partial steering authority — the right-thumb
      // swipe is the primary steering, like aiming in CoD Mobile. A dedicated
      // joystick gets near-full authority so corners feel responsive.
      const joySteer = this.analogSteer !== null ? this.analogSteer * 0.8 : null
      const aSt = this.padSteer ?? this.swipeSteer ?? joySteer
      const steer = aSt !== null ? -aSt : (left ? 1 : 0) - (right ? 1 : 0)
      const grip = handbrake ? 1.4 : 7.5 * tiresMul * bd.grip
      // Steering authority normally scales with speed — but a throttle-held
      // crawl must STILL turn (GTA-style). Without this floor, a car rolling
      // at 2 km/h on sand ignores the swipe entirely and feels broken.
      const speedF = Math.max(
        THREE.MathUtils.clamp(Math.abs(s) / 10, 0, 1),
        gas || braking ? 0.35 : 0
      )
      const turnRate = steer * 2.1 * tiresMul * bd.steer * speedF * (handbrake ? 1.5 : 1)
      this.heading += turnRate * dt * Math.sign(s >= 0 ? 1 : -1)
      const newDir = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))
      const lat = this.vel.clone().sub(newDir.clone().multiplyScalar(this.vel.dot(newDir)))
      lat.multiplyScalar(Math.exp(-dt * grip))
      this.vel.copy(newDir.multiplyScalar(s)).add(lat)
      const onRoad = this.isOnRoad(this.pos.x, this.pos.z)
      // Off-road (sand/grass) slows you but must never feel like wet cement —
      // the beach is a playground, not a trap. 1.2 gives ~70 km/h cruising on
      // sand vs ~130 on asphalt, and lifting the throttle doesn't slam the
      // car to a standstill.
      const drag = onRoad ? 0.38 : 1.2
      this.vel.multiplyScalar(Math.exp(-dt * drag))
      // Beach nudge: sand is a playground, never a trap — but a one-line toast
      // (rate-limited, notification column, zero overlay) points the player
      // back to the asphalt the first time they hit the beach.
      const outCity = Math.abs(this.pos.x) > HALF + 2 || Math.abs(this.pos.z) > HALF + 2
      const onSand = outCity && !onRoad
      this.sandHintT -= dt
      if (onSand && !this.onSand && this.sandHintT <= 0 && Math.abs(s) > 3 && !this.attract && !this.wrecked) {
        this.hooks.onToast('🏖️ Sand eats your speed — the road is where she flies', 'info')
        this.sandHintT = 45
      }
      this.onSand = onSand
      // Stuck detection — NET-PROGRESS based, so it can never interrupt a car
      // that is actually moving. Samples every 0.75s: gas held + barely moved
      // this sample → possible wedge. But if the car has made >4u of NET ground
      // since the episode began, it is crawling through a tight spot, not
      // stuck — the episode resets. Only a genuinely wedged car (zero net
      // progress for ~7s while holding gas) gets the auto-respawn.
      this.stuckRefTimer -= dt
      if (this.stuckRefTimer <= 0) {
        const moved = this.pos.distanceTo(this.stuckRef)
        if (gas && this.grounded && moved < 1.2 && this.vel.lengthSq() < 4) {
          this.stuckTime += 0.75
          if (this.pos.distanceTo(this.stuckEpStart) > 4) {
            // slow but making ground (crawling, weaving) — not stuck
            this.stuckTime = 0
            this.stuckAuto = 0
            this.stuckEpStart.copy(this.pos)
          } else if (this.stuckTime > 2.25) {
            this.stuckLatch = 6
          }
        } else {
          this.stuckTime = 0
          this.stuckAuto = 0
          this.stuckLatch = Math.max(0, this.stuckLatch - 0.75)
          this.stuckEpStart.copy(this.pos)
        }
        this.stuckRef.copy(this.pos)
        this.stuckRefTimer = 0.75
      }
      // Driving freely again clears everything immediately.
      if (this.vel.lengthSq() > 25) {
        this.stuckLatch = 0
        this.stuckTime = 0
        this.stuckAuto = 0
        this.stuckEpStart.copy(this.pos)
      }
      // Auto-respawn after ~7s of zero net progress — the AAA "respawning…" net
      if (this.stuckTime > 2.25 && !this.busted) {
        this.stuckAuto += dt
        if (this.stuckAuto > 4.5) {
          this.resetToRoad()
          this.stuckAuto = 0
          this.stuckEpStart.copy(this.pos)
        }
      }
    } else {
      this.vel.multiplyScalar(Math.exp(-dt * 3))
    }

    // Brake / boost light feedback
    this.taillightMat.color.setHex((effThr !== null ? effThr < -0.12 : down) && !frozen ? 0xff5566 : 0x881122)
    this.flameL.visible = this.boosting
    this.flameR.visible = this.boosting
    if (this.boosting) {
      const f = 0.8 + Math.random() * 0.6
      this.flameL.scale.set(1, f, 1)
      this.flameR.scale.set(1, 0.8 + Math.random() * 0.6, 1)
    }

    // Gravity / jumps — hit a ramp fast (especially on nitro) and you can
    // clear a rooftop: above y=5 building collision is skipped mid-flight.
    if (this.grounded) {
      for (const r of this.ramps) {
        const dx = this.pos.x - r.x
        const dz = this.pos.z - r.z
        const sp = this.vel.length()
        if (dx * dx + dz * dz < 9 && sp > 13) {
          this.vy = sp * 0.6 * LAUNCH_MUL(upg.suspension ?? 0) * bd.launch
          this.grounded = false
          this.airTime = 0
          this.synth.jump()
        }
      }
    }
    if (!this.grounded) {
      this.vy -= 26 * dt
      this.pos.y += this.vy * dt
      this.airTime += dt
      if (this.pos.y <= 0) {
        this.pos.y = 0
        this.grounded = true
        if (this.airTime > 0.55) {
          this.addChain(this.airTime * 90, 'Airtime')
        }
        this.landJumpCred()
        this.vy = 0
      }
    }

    this.pos.addScaledVector(this.vel, dt)
    this.collide()

    // Drift scoring + tire smoke
    const spNow = this.vel.length()
    if (!frozen && handbrake && spNow > 9 && Math.abs((left ? 1 : 0) - (right ? 1 : 0)) > 0) {
      this.drifting = true
      this.driftScore += spNow * dt * 2.4
      if (Math.random() < 0.65 && this.grounded) {
        const side = new THREE.Vector3(dir.z, 0, -dir.x)
        this.emitPuff(
          this.pos.x - dir.x * 1.7 + side.x * (Math.random() - 0.5) * 1.6,
          0.35,
          this.pos.z - dir.z * 1.7 + side.z * (Math.random() - 0.5) * 1.6,
          0x8a94a8, 0.9 + Math.random() * 0.5, 0.65, false
        )
      }
    } else if (this.drifting) {
      this.drifting = false
      if (this.driftScore > 40) {
        const pay = this.addChain(this.driftScore, 'Drift bonus')
        save.stats.bestDrift = Math.max(save.stats.bestDrift, pay)
        if (pay >= 500) this.unlockAchievement('drift-500')
        this.hooks.commit()
      }
      this.driftScore = 0
    }

    // Shard pickup
    for (const sh of this.shards) {
      if (sh.taken) continue
      if (sh.mesh.position.distanceToSquared(this.pos) < 12.5) {
        sh.taken = true
        sh.mesh.visible = false
        save.shards.push(sh.id)
        this.addChain(45, 'Data shard secured')
        this.bumpGoal('shards3')
        this.grantXp(30)
        this.synth.pickup()
        this.hooks.commit()
        if (save.shards.length >= 12) this.unlockAchievement('shard-12')
        if (save.shards.length >= 24) this.unlockAchievement('shard-24')
      }
    }

    this.nearGarage = this.pos.distanceTo(this.garagePos) < 17

    // Apply to meshes
    this.car.position.copy(this.pos)
    this.car.rotation.y = this.heading
    const spin = s * dt / 0.38
    for (const w of this.wheels) w.rotation.x += spin
    this.shake = Math.max(0, this.shake - dt * 1.8)
  }

  private isOnRoad(x: number, z: number): boolean {
    // South bridge deck + lighthouse island count as drivable surface —
    // without this the off-road drag makes them feel like wet cement
    if (z > HALF + 38) {
      if (Math.abs(x) < 9.5 && z < HALF + 130) return true
      if (Math.hypot(x, z - (HALF + 170)) < 47) return true
    }
    const rx = ((x + HALF) % CELL + CELL) % CELL
    const rz = ((z + HALF) % CELL + CELL) % CELL
    return rx < ROAD || rz < ROAD
  }

  private collide(): void {
    const r = CAR_R
    const resolve = (minX: number, maxX: number, minZ: number, maxZ: number): void => {
      const cx = THREE.MathUtils.clamp(this.pos.x, minX, maxX)
      const cz = THREE.MathUtils.clamp(this.pos.z, minZ, maxZ)
      const dx = this.pos.x - cx
      const dz = this.pos.z - cz
      const d2 = dx * dx + dz * dz
      if (d2 >= r * r) return
      const d = Math.sqrt(d2) || 0.001
      const nx = dx / d
      const nz = dz / d
      const push = r - d
      this.pos.x += nx * push
      this.pos.z += nz * push
      const vDot = this.vel.x * nx + this.vel.z * nz
      if (vDot < 0) {
        const impact = -vDot
        // Impact-scaled restitution: a gentle scrape against a pole or wall
        // SLIDES along it (keeps your momentum, GTA-style); only a genuine
        // crash gets bounced back. The old flat 1.85 rebound reversed the car
        // on the lightest touch — that was the "everything stops me" feeling.
        const bounce = impact > 6 ? 1.85 : 1.05
        this.vel.x -= nx * vDot * bounce
        this.vel.z -= nz * vDot * bounce
        // Grazes still register: tiny jolt so clipping a pole never feels free
        if (impact > 1.5) this.shake = Math.min(this.shake + impact * 0.02, 0.85)
        if (impact > 2.5) {
          this.shake = Math.min(this.shake + impact * 0.05, 0.85)
          this.synth.thud()
          // Only a real crash (>14 km/h into the wall) dents the body — a
          // learner's low-speed nudges thud and shake but don't cost money.
          if (impact > 4) { this.lastHitKmh = Math.round(impact * 3.6); this.lastHitCause = 'a wall'; this.addDamage(impact * 0.4) }
          this.emitPuff(
            this.pos.x + nx * 1.6, 0.5 + Math.random() * 0.4, this.pos.z + nz * 1.6,
            0xffd27d, 0.2 + Math.random() * 0.15, 0.25, true
          )
        }
        if (impact > 8) {
          // Hard hit: heavy crash sound, bigger spark burst, speed bleeds off
          this.synth.crash()
          this.vel.multiplyScalar(0.72)
          for (let i = 0; i < 8; i++) {
            this.emitPuff(
              this.pos.x + nx * 1.6 + (Math.random() - 0.5),
              0.5 + Math.random() * 0.5,
              this.pos.z + nz * 1.6 + (Math.random() - 0.5),
              0xffa63d, 0.28 + Math.random() * 0.2, 0.3, true
            )
          }
        }
        if (impact > 12 && this.heatAllowed) this.heat = Math.min(5, this.heat + 0.35)
      }
    }
    if (this.pos.y < 5) {
      for (const b of this.buildings) resolve(b.minX, b.maxX, b.minZ, b.maxZ)
    }
    // Soft world bounds — wide enough to roam the beach ring (sand spans HALF+5.5 … HALF+46)
    const L = HALF + 38
    if (this.pos.x < -L) { this.pos.x = -L; this.vel.x = Math.abs(this.vel.x) * 0.4 }
    if (this.pos.x > L) { this.pos.x = L; this.vel.x = -Math.abs(this.vel.x) * 0.4 }
    if (this.pos.z < -L) { this.pos.z = -L; this.vel.z = Math.abs(this.vel.z) * 0.4 }
    // South: past the sand the only way out to sea is the bridge deck, and it
    // ends at the lighthouse island. Rails and the island rim do the clamping.
    if (this.pos.z > L) {
      const islandC = HALF + 170
      const dzI = this.pos.z - islandC
      const rI = Math.hypot(this.pos.x, dzI)
      if (Math.abs(this.pos.x) < 8.4 && this.pos.z < islandC - 36) {
        // Bridge deck — the neon rails mark the edges; the corridor is open
      } else if (rI < 47) {
        // Open island ground — clamp at the sand rim (but never trap the
        // bridge mouth: the corridor branch above wins there)
        if (rI > 44) {
          const f = 44 / rI
          this.pos.x *= f
          this.pos.z = islandC + dzI * f
          this.vel.multiplyScalar(0.5)
        }
      } else if (Math.abs(this.pos.x) < 14 && this.pos.z < islandC - 40) {
        // Straddling a rail — nudge back onto the deck
        this.pos.x = Math.sign(this.pos.x || 1) * 8.4
        this.vel.x = -this.vel.x * 0.3
      } else {
        // Open sea — bounce back to the beach
        this.pos.z = L
        this.vel.z = -Math.abs(this.vel.z) * 0.4
      }
    }
  }

  /** Add body damage from a crash. Heavy damage bleeds speed, fades the paint,
      pours smoke — and at 100% the car explodes (WRECKED game over). */
  private addDamage(amount: number): void {
    if (amount <= 0 || this.wrecked) return
    // Roll Cage upgrade soaks a chunk of every impact
    amount *= ARMOR_MUL(this.hooks.getSave().upgrades?.armor ?? 0)
    // World Circuit (v2): a split radiator runs hot — impacts sting harder
    amount *= breakdownMuls(this.hooks.getSave().breakdown).dmg
    // First Night is the driving lesson, not the bill: while the tutorial is
    // running, damage caps at 60% — dents and smoke, never a WRECKED screen.
    const cap = this.hooks.getSave().tutorialDone ? 100 : 60
    const before = this.damage
    this.damage = Math.min(cap, this.damage + amount)
    // Any damage breaks the cred chain; mid-air damage ruins the clean landing
    if (this.damage > before) {
      this.breakCred()
      if (!this.grounded) this.jumpDamaged = true
      // Contract modifiers (fragile/clean/vip) count every hit that stuck
      if (this.mission) this.mission.damageHits++
    }
    this.applyDamageLook()
    if (this.damage >= 50 && !this.damageWarned50) {
      this.damageWarned50 = true
      this.hooks.onToast('Body work is dented — she\'s losing power. The garage can hammer it out', 'info')
    }
    if (this.damage >= 80 && !this.damageWarned80) {
      this.damageWarned80 = true
      this.hooks.onToast('She\'s smoking bad — one more hard hit and she\'s done!', 'warn')
    }
    // Persist in 4-point steps so a demolition derby doesn't hammer localStorage
    if (Math.abs(this.damage - this.damageCommitAt) >= 4 || this.damage >= 100) {
      this.damageCommitAt = this.damage
      const save = this.hooks.getSave()
      save.damage = Math.round(this.damage)
      this.hooks.commit()
    }
    if (this.damage >= 100) this.explode()
  }

  /** Paint fades + clearcoat dulls as damage climbs — a beaten car looks beaten. */
  private applyDamageLook(): void {
    const f = this.damage / 100
    const faded = this.baseBodyColor.clone().lerp(new THREE.Color(0x4a4d52), f * 0.8)
    this.bodyMat.color.copy(faded)
    this.bodyMat.clearcoat = 1 - f * 0.75
    this.bodyMat.roughness = 0.2 + f * 0.55
  }

  /** 100% damage: the car goes up in a fireball. Game over — tow it home. */
  private explode(): void {
    if (this.wrecked) return
    this.wrecked = true
    this.wreckBurnT = 0
    this.slowmoT = 1.4 // kill-cam: explosion plays in slow motion before the card
    this.synth.explosion()
    this.shake = 1.6
    this.speakPanic(true)
    // Fireball: a ring of fire puffs + thick black smoke column
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * 2.6
      this.emitPuff(
        this.pos.x + Math.cos(a) * r, 0.4 + Math.random() * 2.4, this.pos.z + Math.sin(a) * r,
        Math.random() > 0.4 ? 0xff7a1a : 0xffd23d, 2.2 + Math.random() * 1.6, 1.1, true
      )
    }
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2
      this.emitPuff(
        this.pos.x + Math.cos(a) * 1.6, 1.5 + Math.random() * 3, this.pos.z + Math.sin(a) * 1.6,
        0x1c1c20, 2.8 + Math.random() * 1.4, 2.4, false
      )
    }
    // The wreck keeps the damage; save it
    const save = this.hooks.getSave()
    save.damage = 100
    // World Circuit (v2): every WRECK breaks something real. The part stays
    // broken with a driving penalty until the garage repairs it — and the
    // run itself (odometer + city zone) is never reset.
    save.breakdown = rollBreakdown(save.breakdown ?? null)
    this.hooks.commit()
    this.hooks.onWrecked()
  }

  /** After WRECKED: pay the tow, the car is hauled to the garage, patched to 45%. */
  towToGarage(): void {
    if (!this.wrecked) return
    const save = this.hooks.getSave()
    const firstTow = save.stats.tows === 0
    // Design 4.5: tow = 10% of cash, min $50, max $250 (never more than you have)
    const fee = firstTow ? 0 : Math.min(save.cash, Math.max(50, Math.min(250, Math.round(save.cash * 0.1))))
    save.cash -= fee
    save.stats.tows += 1
    this.damage = 45
    this.damageCommitAt = 45
    this.damageWarned80 = false
    save.damage = 45
    this.hooks.commit()
    this.wrecked = false
    this.lastHitKmh = 0
    this.lastHitCause = ''
    this.applyDamageLook()
    this.vel.set(0, 0, 0)
    this.heat = 0
    this.debugTeleport(this.garagePos.x + 4, this.garagePos.z, Math.PI / 2)
    const bd = breakdownById(save.breakdown)
    if (firstTow) {
      this.hooks.onToast(bd ? `First tow's on the house — ${bd.icon} ${bd.name} broke. Fix it at the garage` : "First tow's on the house — get her repaired", 'info')
    } else {
      this.hooks.onToast(bd ? `Towed to the garage (-$${fee}) — ${bd.icon} ${bd.name} broke. Fix it at the garage` : `Towed to the garage (-$${fee}) — get her repaired`, 'info')
    }
  }

  /** Repair quote at the garage: $3 per damage point, capped at $200 (design
      4.5). The first repair of a save is free — nobody learns to drive and
      pays full price for it. */
  repairCost(): number {
    if (this.hooks.getSave().stats.repairs === 0 && this.damage >= 1) return 0
    return Math.min(200, Math.ceil(this.damage * 3))
  }

  /** World Circuit (v2): the broken part's repair bill — base cost × distance
      multiplier (1 + 0.5 × city zone index). Zero when nothing is broken. */
  breakdownCost(): number {
    const save = this.hooks.getSave()
    const bd = breakdownById(save.breakdown)
    if (!bd) return 0
    if (save.stats.repairs === 0 && (this.damage >= 1 || save.breakdown)) return 0 // first repair is free
    return breakdownCost(bd, zoneAt(save.worldKm ?? 0).index)
  }

  /** Total repair bill at the garage (body + any broken part). */
  totalRepairCost(): number {
    return this.repairCost() + this.breakdownCost()
  }

  /** Full repair at the garage — body damage AND any broken part. Returns
      true if paid and fixed. The run itself (odometer + city zone) is never
      touched: you fix what broke and continue the same map. */
  repair(): boolean {
    const save = this.hooks.getSave()
    const firstRepair = save.stats.repairs === 0
    const cost = this.totalRepairCost()
    if ((this.damage < 1 && !save.breakdown) || save.cash < cost) return false
    save.cash -= cost
    save.stats.repairs += 1
    this.damage = 0
    this.damageCommitAt = 0
    this.damageWarned50 = false
    this.damageWarned80 = false
    save.damage = 0
    const bd = breakdownById(save.breakdown)
    save.breakdown = null
    this.hooks.commit()
    this.applyDamageLook()
    this.synth.missionDone()
    if (firstRepair) {
      this.hooks.onToast("First repair's on the house — good as new", 'good')
    } else if (bd) {
      this.hooks.onToast(`${bd.icon} ${bd.name} fixed — good as new (-$${cost})`, 'good')
    } else {
      this.hooks.onToast(`Good as new — repairs done (-$${cost})`, 'good')
    }
    return true
  }

  /** Panicked pedestrian voice lines via speech synthesis — rate-limited. */
  private speakPanic(force = false): void {
    if (!force && this.screamCd > 0) return
    this.screamCd = force ? 0.8 : 1.6
    try {
      const ss = window.speechSynthesis
      if (!ss) return
      const lines = [
        'Oh no!', "Don't kill me!", 'Watch out!', 'Help!', 'Aah!',
        "Hey! I'm walking here!", 'Are you blind?!', 'Somebody call the patrol!',
      ]
      const u = new SpeechSynthesisUtterance(lines[Math.floor(Math.random() * lines.length)])
      u.pitch = 1.2 + Math.random() * 0.7
      u.rate = 1.1 + Math.random() * 0.4
      u.volume = 0.75
      ss.speak(u)
    } catch {
      /* speech unavailable — the dive animation still sells the panic */
    }
  }

  /** HORN: blast the two-tone, pedestrians dive aside, traffic ahead pulls over.
      Air Horns upgrade widens the blast radius. */
  hornBlast(): void {
    if (this.hornCd > 0) return
    this.hornCd = 0.8
    this.synth.horn()
    const range = HORN_RANGE(this.hooks.getSave().upgrades?.horn ?? 0)
    let panicked = false
    for (const p of this.peds) {
      if (p.state !== 0) continue
      const dx = p.x - this.pos.x
      const dz = p.z - this.pos.z
      if (dx * dx + dz * dz < range * range) {
        p.panicT = 2.2
        panicked = true
      }
    }
    if (panicked && Math.random() < 0.5) this.speakPanic()
    // Traffic ahead in the same direction yields: drift toward the road edge
    const dir = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))
    for (const t of this.traffic) {
      if (t.zone !== this.lastZoneId) continue
      const rx = t.mesh.position.x - this.pos.x
      const rz = t.mesh.position.z - this.pos.z
      const ahead = rx * dir.x + rz * dir.z
      if (ahead > 2 && ahead < 18 && Math.abs(rx * dir.z - rz * dir.x) < 5) t.yieldT = 2.5
    }
  }

  /** Police chopper spotlight: pins the car in a sweeping beam while a chase
      is on — pure Hollywood, sells the "save yourself" moment. */
  private updateChaseSpotlight(): void {
    const active = this.heat >= 1 && !this.busted && !this.wrecked && this.cruiserNearest < 40
    if (active && !this.chaseSpot) {
      this.chaseSpot = new THREE.SpotLight(0xcfe6ff, 0, 140, 0.32, 0.45, 1)
      // Adding a light mid-game recompiles every material: on a phone that is
      // a visible freeze the moment a chase starts. Phones get the beam cone only.
      if (!this.lowPower) this.scene.add(this.chaseSpot, this.chaseSpot.target)
      const coneGeom = new THREE.CylinderGeometry(0.6, 7.5, 34, 16, 1, true)
      coneGeom.translate(0, -17, 0) // origin at the top, opens downward
      this.chaseCone = new THREE.Mesh(coneGeom, new THREE.MeshBasicMaterial({
        color: 0xcfe6ff, transparent: true, opacity: 0.1, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }))
      this.chaseCone.visible = false
      this.scene.add(this.chaseCone)
    }
    if (!this.chaseSpot || !this.chaseCone) return
    if (!active) {
      this.chaseSpot.intensity = 0
      this.chaseCone.visible = false
      return
    }
    // The chopper hovers above the car, swaying gently as it tracks
    const sway = this.time * 0.7
    const sx = this.pos.x + Math.sin(sway) * 7
    const sz = this.pos.z + Math.cos(sway * 0.8) * 7
    const sy = 34
    this.chaseSpot.position.set(sx, sy, sz)
    this.chaseSpot.target.position.set(this.pos.x, 0.5, this.pos.z)
    this.chaseSpot.intensity = 260
    this.chaseCone.visible = true
    this.chaseCone.position.set(sx, sy, sz)
    const dir = new THREE.Vector3(this.pos.x - sx, 0.5 - sy, this.pos.z - sz).normalize()
    this.chaseCone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir)
    ;(this.chaseCone.material as THREE.MeshBasicMaterial).opacity = 0.08 + Math.sin(this.time * 6) * 0.03
  }

  private grantCash(amount: number): void {    const save = this.hooks.getSave()
    save.cash = Math.max(0, save.cash + amount)
    this.hooks.commit()
    // Reward feedback: register ping, rate-limited so chains don't machine-gun
    if (amount > 0 && this.time - this.lastCashSfx > 0.35) {
      this.lastCashSfx = this.time
      this.synth.cash()
    }
    if (save.cash >= 5000) this.unlockAchievement('rich-5k')
  }

  private lastCashSfx = -9

  // PC-7: achievements — one-shot unlocks with a toast + jingle (+$150 bonus)
  unlockAchievement(id: string): void {
    const save = this.hooks.getSave()
    if (save.achievements.includes(id)) return
    save.achievements.push(id)
    this.hooks.commit()
    const a = ACHIEVEMENTS.find((x) => x.id === id)
    if (a) {
      this.hooks.onToast(`🏆 ${a.name} — ${a.desc} (+$150)`, 'good')
      this.synth.missionDone()
      this.grantCash(150)
      if (save.achievements.filter((x) => ACHIEVEMENTS.some((y) => y.id === x)).length === ACHIEVEMENTS.length) {
        this.hooks.onToast('👑 ALL TROPHIES — you are the legend of Neon Harbor!', 'good')
      }
    }
  }

  // PC-7: district gates — locked districts block the player at the border.
  // The gate is a SOFT WALL: only the inward velocity component is removed, so
  // the car slides along the border instead of being teleported and wedged.
  /** Fast travel — every district is open from the first minute. Drops the
      car on the road junction nearest the district's centre, facing downtown.
      Refused mid-job and mid-chase so it can never be an escape button. */
  travelToDistrict(id: string): boolean {
    const d = DISTRICTS.find((x) => x.id === id)
    if (!d || this.wrecked || this.busted || this.attract) return false
    if (this.mission) {
      this.hooks.onToast('Finish your current job first — then pick a district', 'warn')
      return false
    }
    if (this.heat >= 1) {
      this.hooks.onToast('Lose the Patrol first — no travelling mid-chase', 'warn')
      return false
    }
    if (id === 'downtown') {
      this.debugTeleport(this.garagePos.x, this.garagePos.z + 19, Math.PI)
    } else {
      // Road junctions sit on the same grid roadPoint() uses.
      const snap = (v: number, lo: number, hi: number): number => {
        let best = 0
        let bestD = Infinity
        for (let k = 0; k <= N; k++) {
          const c = -HALF + ROAD / 2 + k * CELL
          if (c < lo + 6 || c > hi - 6) continue
          const dd = Math.abs(c - v)
          if (dd < bestD) { bestD = dd; best = c }
        }
        return best
      }
      const x = snap((d.minX + d.maxX) / 2, d.minX, d.maxX)
      const z = snap((d.minZ + d.maxZ) / 2, d.minZ, d.maxZ)
      // Always face along the north–south avenue, towards the middle of the
      // map: the east–west streets carry median barriers right off the
      // junction, the avenues give a clear run.
      const heading = z > 0 ? Math.PI : 0
      this.debugTeleport(x, z, heading)
    }
    this.stuckTime = 0
    this.synth.checkpoint()
    this.hooks.onToast(`📍 ${d.name} — ${d.desc}`, 'good')
    return true
  }

  // Every district is open from the start; first visits still pay a bonus.
  private districtCd = 0
  private districtToastAt: Record<string, number> = {}
  private updateDistricts(dt: number): void {
    this.districtCd = Math.max(0, this.districtCd - dt)
    const save = this.hooks.getSave()
    const d = districtAt(this.pos.x, this.pos.z)
    if (d && save.level < d.minLevel) {
      // Locked district — the car ALWAYS passes. No invisible wall, no clamp,
      // no bounce: the level gate applies to the WORK offered here (mission
      // spawns already respect minLevel), never to movement. One quiet note
      // per district per 2 minutes is all the player needs.
      const lastToast = this.districtToastAt[d.name] ?? -1e9
      if (this.time - lastToast > 120) {
        this.districtToastAt[d.name] = this.time
        this.hooks.onToast(`🔒 ${d.name} — jobs here open at level ${d.minLevel}. You can drive through freely`, 'info')
      }
      return
    }
    if (!d) return
    if (!save.districts.includes(d.id)) {
      save.districts.push(d.id)
      this.hooks.commit()
      this.hooks.onToast(`🗺️ Welcome to ${d.name} — ${d.desc} (+$100 discovery bonus)`, 'good')
      this.synth.missionDone()
      this.grantCash(100)
      if (save.districts.length >= DISTRICTS.length) this.unlockAchievement('tour')
    }
  }

  private grantXp(amount: number): void {
    const save = this.hooks.getSave()
    const ups = grantXp(save, amount)
    if (ups > 0) {
      for (let i = 0; i < ups; i++) this.hooks.onLevelUp(save.level - ups + i + 1)
      this.synth.missionDone()
      if (save.level >= 5) this.unlockAchievement('level-5')
    }
  }

  // =============== TRAFFIC ===============
  private updateTraffic(dt: number): void {
    for (const t of this.traffic) {
      if (t.zone !== this.lastZoneId) continue
      const p = t.mesh.position
      // Player blocking ahead? (same lane, in front, close)
      const along = t.axis === 'x' ? p.x : p.z
      const playerAlong = t.axis === 'x' ? this.pos.x : this.pos.z
      const playerLat = t.axis === 'x' ? this.pos.z : this.pos.x
      const rel = (playerAlong - along) * t.dir
      let blocked = rel > 0 && rel < 11 && Math.abs(playerLat - t.lane) < 3 && this.pos.y < 2
      // Accident wreck ahead on this road? Brake and queue behind it — this is
      // what makes the jam behind a crash read as a real pile-up.
      const ac = this.accident
      if (!blocked && ac && ac.axis === t.axis) {
        const aRel = (ac.along - along) * t.dir
        if (aRel > 0 && aRel < 12 && Math.abs(ac.lat - t.lane) < 4.5) blocked = true
      }
      // Obey the signals at the central crossroads: ease to the stop line on red,
      // and treat amber as "stop unless too close to stop safely"
      let lightCap: number | null = null
      const ph = this.time % 14
      for (const li of this.lightIntersections) {
        const cross = t.axis === 'x' ? li.z : li.x
        const d = (cross - along) * t.dir
        if (d > 0.5 && d < 16) {
          const green = t.axis === 'x' ? ph < 8 : ph >= 9.5 && ph < 12.5
          const amber = t.axis === 'x' ? ph >= 8 && ph < 9.5 : ph >= 12.5
          if (!green && !(amber && d < 7)) {
            lightCap = d < 5 ? 0 : t.cruise * Math.max(0, (d - 5) / 11)
          }
          break
        }
      }
      let target = blocked ? 0 : t.cruise * (this.rushActive ? 0.45 : 1)
      if (lightCap !== null) target = Math.min(target, lightCap)
      // Car-following: never rear-end the car ahead in the same lane — queues
      // form naturally at red lights, accidents and rush-hour crawl.
      for (const o of this.traffic) {
        if (o.zone !== t.zone) continue
        if (o === t || o.axis !== t.axis || o.dir !== t.dir) continue
        if (Math.abs(o.lane - t.lane) > 1.5) continue
        const oAlong = t.axis === 'x' ? o.mesh.position.x : o.mesh.position.z
        const gap = (oAlong - along) * t.dir
        if (gap > 0 && gap < 9) {
          const cap = Math.max(0, (gap - 5.5) * 1.4)
          if (cap < target) target = cap
          break
        }
      }
      const braking = blocked || (lightCap !== null && lightCap < t.speed)
      t.speed += (target - t.speed) * Math.min(dt * (braking ? 5 : 0.8), 1)
      // Horn yield: drift toward the road edge to let the player through
      t.yieldT = Math.max(0, t.yieldT - dt)
      if (t.yieldT > 0) {
        const rc = -HALF + ROAD / 2 + Math.round((t.lane + HALF - ROAD / 2) / CELL) * CELL
        const side = t.lane >= rc ? 1 : -1
        const edge = rc + side * (ROAD / 2 - 1.6)
        t.lane += (edge - t.lane) * Math.min(dt * 2.2, 1)
        t.speed += t.cruise * 0.15 * dt
      }
      const step = t.speed * dt * t.dir
      if (t.axis === 'x') p.x += step
      else p.z += step
      // Wrap around
      if (along > HALF + 10) {
        if (t.axis === 'x') p.x = -HALF - 10
        else p.z = -HALF - 10
      } else if (along < -HALF - 10) {
        if (t.axis === 'x') p.x = HALF + 10
        else p.z = HALF + 10
      }
      // Collision with player (circle vs circle)
      const dx = this.pos.x - p.x
      const dz = this.pos.z - p.z
      const d2 = dx * dx + dz * dz
      // Near-miss chain reward: skim past traffic at speed
      t.nmCooldown -= dt
      const playerSp = this.vel.length()
      const dNow = Math.sqrt(d2)
      // Anti-farm: relative speed must exceed 40 km/h — parked/slow cars and
      // same-pace cruising don't count. 3s cooldown per vehicle (nmCooldown).
      const tvx = t.axis === 'x' ? t.speed * t.dir : 0
      const tvz = t.axis === 'z' ? t.speed * t.dir : 0
      const relKmh = Math.hypot(this.vel.x - tvx, this.vel.z - tvz) * 3.6
      if (t.nmCooldown <= 0 && dNow > 2.4 && dNow < 5.4 && playerSp * 3.6 > 60 && relKmh > 40) {
        t.nmCooldown = 3
        this.addChain(30, 'Near miss')
        this.addCred(25)
        this.synth.checkpoint()
      }
      const rr = 3.4
      if (d2 < rr * rr && this.pos.y < 2) {
        const d = Math.sqrt(d2) || 0.01
        const nx = dx / d
        const nz = dz / d
        const push = rr - d
        this.pos.x += nx * push * 0.7
        this.pos.z += nz * push * 0.7
        const vDot = this.vel.x * nx + this.vel.z * nz
        if (vDot < 0) {
          const impact = -vDot
          this.vel.x -= nx * vDot * 1.4
          this.vel.z -= nz * vDot * 1.4
          this.vel.multiplyScalar(0.82)
          if (impact > 4) {
            this.shake = Math.min(this.shake + impact * 0.04, 0.8)
            this.synth.thud()
            // Traffic dents only above ~25 km/h closing speed (Kimi's tuning
            // run: slow city bumps were bankrupting careful-but-bad drivers).
            if (impact > 7) { this.lastHitKmh = Math.round(impact * 3.6); this.lastHitCause = 'another car'; this.addDamage(impact * 0.3) }
            if (impact > 10 && this.heatAllowed) this.heat = Math.min(5, this.heat + 0.25)
          }
        }
      }
    }
  }

  // =============== ROAD EVENTS: ACCIDENTS & RUSH HOUR ===============
  // The only sanctioned reasons traffic (and the player) ever stop — both are
  // physical and visible: a crash scene blocking a street, and rush-hour
  // crawl on the central avenues.
  private updateRoadEvents(dt: number): void {
    // ---- Accident lifecycle ----
    if (!this.accident) {
      this.accidentTimer -= dt
      if (this.accidentTimer <= 0) this.spawnAccident()
    } else {
      const ac = this.accident
      // Hazard flashers strobe amber
      const on = Math.sin(this.time * 11) > 0
      for (const m of ac.hazardMats) m.opacity = on ? 0.95 : 0.15
      // Smoke curling off the wreck
      ac.smokeTimer -= dt
      if (ac.smokeTimer <= 0) {
        ac.smokeTimer = 0.28
        const sx = ac.axis === 'x' ? ac.along : ac.lat
        const sz = ac.axis === 'x' ? ac.lat : ac.along
        this.emitPuff(sx + (Math.random() - 0.5) * 1.4, 1.6, sz + (Math.random() - 0.5) * 1.4, 0x4a4f58, 2.6, 1.7, false)
      }
      // One bare-text warning when the player gets close — then stay quiet
      if (!ac.warned) {
        const wx = ac.axis === 'x' ? ac.along : ac.lat
        const wz = ac.axis === 'x' ? ac.lat : ac.along
        if ((this.pos.x - wx) ** 2 + (this.pos.z - wz) ** 2 < 55 * 55) {
          ac.warned = true
          this.hooks.onToast('Accident ahead — that street is blocked, take another one', 'warn')
        }
      }
      if (this.time > ac.despawnAt) this.clearAccident()
    }

    // ---- Rush-hour lifecycle ----
    if (!this.rushActive) {
      this.rushTimer -= dt
      if (this.rushTimer <= 0) this.startRushHour()
    } else if (this.time > this.rushUntil) {
      this.endRushHour()
    }
  }

  private spawnAccident(): void {
    // Pick a road spot well away from the player and clear of intersections
    let axis: 'x' | 'z' = 'x'
    let lat = 0
    let along = 0
    let ok = false
    for (let tries = 0; tries < 12 && !ok; tries++) {
      axis = Math.random() > 0.5 ? 'x' : 'z'
      const k = Math.floor(Math.random() * (N + 1))
      lat = -HALF + ROAD / 2 + k * CELL
      along = (Math.random() * 2 - 1) * (HALF - 25)
      const wx = axis === 'x' ? along : lat
      const wz = axis === 'x' ? lat : along
      if ((this.pos.x - wx) ** 2 + (this.pos.z - wz) ** 2 < 70 * 70) continue
      ok = true
      for (const li of this.lightIntersections) {
        const cross = axis === 'x' ? li.z : li.x
        const crossAlong = axis === 'x' ? li.x : li.z
        if (Math.abs(cross - lat) < 2 && Math.abs(crossAlong - along) < 16) {
          ok = false
          break
        }
      }
    }
    if (!ok) {
      this.accidentTimer = 30
      return
    }
    const wx = axis === 'x' ? along : lat
    const wz = axis === 'x' ? lat : along
    const headingAxis = axis === 'x' ? Math.PI / 2 : 0 // car forward along road

    const group = new THREE.Group()
    group.position.set(wx, 0, wz)
    const hazardMats: THREE.MeshBasicMaterial[] = []
    const boxStart = this.buildings.length
    const idlerStart = this.idlers.length
    const rand = Math.random

    // Two wrecked cars, skewed across both lanes, dark burnt-out colors
    const wreckCols = [0x23262e, 0x2e3138]
    for (let i = 0; i < 2; i++) {
      const wreck = this.makeTrafficCar(i === 0 ? 'sedan' : 'hatch', wreckCols[i])
      const side = i === 0 ? -1.6 : 1.8
      const fwd = i === 0 ? -1.2 : 1.6
      const lx = axis === 'x' ? fwd : side
      const lz = axis === 'x' ? side : fwd
      wreck.position.set(lx, 0, lz)
      wreck.rotation.y = headingAxis + (i === 0 ? 0.55 : -0.65) + (rand() - 0.5) * 0.2
      group.add(wreck)
      // Hazard flasher on the roof — strobes via updateRoadEvents
      const hMat = new THREE.MeshBasicMaterial({ color: 0xffa726, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.9, depthWrite: false })
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 0.4), hMat)
      h.position.set(lx, 1.55, lz)
      group.add(h)
      hazardMats.push(hMat)
      // Solid collider so the player physically cannot drive through the wreck
      this.buildings.push({ minX: wx + lx - 2.6, maxX: wx + lx + 2.6, minZ: wz + lz - 2.6, maxZ: wz + lz + 2.6 })
    }

    // Warning cones in an arc on both approaches
    const coneG = new THREE.ConeGeometry(0.24, 0.62, 10)
    const coneM = new THREE.MeshStandardMaterial({ color: 0xff6d1f, roughness: 0.7, emissive: 0x903500, emissiveIntensity: 0.5 })
    for (let c = 0; c < 6; c++) {
      const cone = new THREE.Mesh(coneG, coneM)
      const approach = c < 3 ? -1 : 1
      const spread = (c % 3 - 1) * 2.4
      const cd = approach * (5.5 + rand() * 1.5)
      const cx = axis === 'x' ? cd : spread
      const cz = axis === 'x' ? spread : cd
      cone.position.set(cx, 0.31, cz)
      group.add(cone)
    }

    // The gathered crowd — a semicircle of bystanders on the sidewalk edge,
    // kept OFF the drive surface so the player never ghosts through people
    const crowdN = 5 + Math.floor(rand() * 3)
    for (let i = 0; i < crowdN; i++) {
      const a = (i / (crowdN - 1) - 0.5) * Math.PI * 1.1 + (rand() - 0.5) * 0.2
      const r = 4.6 + rand() * 1.6
      const spreadAlong = Math.sin(a) * r * 1.2
      const sideOff = 5.4 + Math.abs(Math.cos(a)) * 3.2 + rand() * 0.8
      const lx = axis === 'x' ? spreadAlong : sideOff
      const lz = axis === 'x' ? sideOff : spreadAlong
      this.makeBystander(group, lx, lz, Math.atan2(-lx, -lz))
    }

    this.scene.add(group)
    this.accident = {
      group,
      axis,
      lat,
      along,
      boxStart,
      boxCount: 2,
      idlerStart,
      idlerCount: this.idlers.length - idlerStart,
      hazardMats,
      smokeTimer: 0,
      despawnAt: this.time + 100,
      warned: false,
    }
    this.accidentTimer = 90 + Math.random() * 60
  }

  private clearAccident(): void {
    const ac = this.accident
    if (!ac) return
    this.scene.remove(ac.group)
    this.buildings.splice(ac.boxStart, ac.boxCount)
    this.idlers.splice(ac.idlerStart, ac.idlerCount)
    this.accident = null
  }

  /** Standing onlooker, parented to the accident group (positions are local). */
  private makeBystander(parent: THREE.Group, px: number, pz: number, rotY: number): void {
    const charKeys = Object.keys(this.assets.chars)
    if (charKeys.length === 0) return
    const key = charKeys[Math.floor(Math.random() * charKeys.length)]
    const { obj, clips } = cloneCharacter(this.assets, key)
    const bb = new THREE.Box3().setFromObject(obj)
    const h = bb.max.y - bb.min.y
    const s = h > 0.01 ? (1.62 + Math.random() * 0.26) / h : 1
    obj.scale.setScalar(s)
    const tints = [0x8a94a6, 0xa67c52, 0x6b7c93, 0x9aa5b1, 0x7c6f8a, 0xb08968, 0x5f6e5e]
    const tint = new THREE.Color(tints[Math.floor(Math.random() * tints.length)])
    obj.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        const mat = (m.material as THREE.MeshStandardMaterial).clone()
        mat.color = tint.clone()
        m.material = mat
      }
    })
    obj.position.y = -bb.min.y * s
    const mixer = new THREE.AnimationMixer(obj)
    const idleClip = clips.find((c) => /idle|stand/i.test(c.name)) ?? clips[0]
    const action = mixer.clipAction(idleClip)
    action.play()
    action.timeScale = 0.85 + Math.random() * 0.3
    const wrap = new THREE.Group()
    wrap.add(obj)
    wrap.position.set(px, 0, pz)
    wrap.rotation.y = rotY
    parent.add(wrap)
    this.idlers.push({ mesh: wrap, mixer, baseY: 0 })
  }

  private startRushHour(): void {
    this.rushActive = true
    this.rushUntil = this.time + 70
    this.rushTimer = 200 + Math.random() * 90
    this.hooks.onToast('Rush hour — the avenues are jammed, side streets are faster', 'info')
    // Flood the two central avenues with extra cars so the crawl is visible
    const styles = ['sedan', 'sedan', 'hatch', 'van', 'taxi', 'hatch', 'sedan', 'van', 'taxi', 'hatch', 'sedan', 'sport', 'van', 'sedan']
    const cols = [0x8d99ae, 0x6fa35f, 0x4f8fb8, 0xe23b3b, 0xb8c0cc, 0x2f9fd8, 0xf0a020, 0x98a5b5, 0x7f8a99, 0x5a6e8c, 0xa8563f, 0x3f7a6e, 0xc9b458, 0x6b5a8c]
    const kC = Math.floor(N / 2)
    for (let i = 0; i < (this.lowPower ? 8 : 14); i++) {
      const style = styles[i % styles.length]
      const g = this.makeTrafficCar(style, style === 'taxi' ? 0xf59e0b : cols[i % cols.length])
      const axis: 'x' | 'z' = i % 2 === 0 ? 'x' : 'z'
      const road = -HALF + ROAD / 2 + (kC + (i % 4 < 2 ? 0 : 1)) * CELL
      const lane = road + (Math.random() > 0.5 ? 2.6 : -2.6)
      const dir: 1 | -1 = lane > road ? 1 : -1
      const along = (Math.random() * 2 - 1) * (HALF - 15)
      if (axis === 'x') {
        g.position.set(along, 0, lane)
        g.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2
      } else {
        g.position.set(lane, 0, along)
        g.rotation.y = dir > 0 ? 0 : Math.PI
      }
      this.scene.add(g)
      const car: TrafficCar = { mesh: g, axis, lane, dir, speed: 0, cruise: 8 + Math.random() * 3, nmCooldown: 0, yieldT: 0, zone: this.lastZoneId }
      this.traffic.push(car)
      this.rushCars.push(car)
    }
  }

  private endRushHour(): void {
    this.rushActive = false
    for (const car of this.rushCars) {
      this.scene.remove(car.mesh)
      const idx = this.traffic.indexOf(car)
      if (idx >= 0) this.traffic.splice(idx, 1)
    }
    this.rushCars = []
  }

  // =============== DRONES / HEAT ===============
  private updateDronesAndHeat(dt: number): void {
    this.mashCooldown = Math.max(0, this.mashCooldown - dt)
    this.droneRamCd = Math.max(0, this.droneRamCd - dt)
    this.cruiserRamCd = Math.max(0, this.cruiserRamCd - dt)
    this.ramToastCd = Math.max(0, this.ramToastCd - dt)
    this.escapeHintCd = Math.max(0, this.escapeHintCd - dt)
    const sp = this.vel.length()
    let nearest = Infinity
    let chased = false
    const rand = Math.random
    const heatSave = this.hooks.getSave()
    // The very first chase of a save is capped at ★1 with no grab.
    const heatAllowed = this.heatAllowed
    if (this.firstChaseDone === null) this.firstChaseDone = heatSave.stats.busts > 0 || heatSave.stats.getaways > 0
    // The first chase a player ever gets: capped at ★1, no grab — one lesson.
    const firstEverChase = !this.firstChaseDone && this.mission?.kind !== 'getaway'

    for (const d of this.drones) {
      d.bob += dt
      const toPlayer = new THREE.Vector3().subVectors(this.pos, d.pos)
      toPlayer.y = 0
      const dist = toPlayer.length()
      nearest = Math.min(nearest, dist)
      this.trackTail(d, dist)

      const chasing = this.heat >= 1 && dist < 130
      if (chasing) {
        chased = true
        const speed = 17 + this.heat * 3.2
        const desired = toPlayer.clone().normalize().multiplyScalar(speed)
        d.vel.lerp(desired, 1 - Math.exp(-dt * 2.2))
      } else {
        const toWp = new THREE.Vector3().subVectors(d.wp, d.pos)
        toWp.y = 0
        if (toWp.length() < 6) d.wp = roadPoint(rand)
        const desired = toWp.clone().normalize().multiplyScalar(8)
        d.vel.lerp(desired, 1 - Math.exp(-dt * 1.5))
      }
      d.pos.addScaledVector(d.vel, dt)
      d.pos.y = 2.2 + Math.sin(d.bob * 3) * 0.3
      d.mesh.position.copy(d.pos)
      if (d.vel.lengthSq() > 0.5) {
        d.mesh.rotation.y = Math.atan2(d.vel.x, d.vel.z)
      }
      // Separation: drones hover BESIDE/BEHIND the car, never inside it.
      if (dist < 2.6) {
        d.pos.add(toPlayer.clone().normalize().multiplyScalar(-(2.6 - dist)))
      }
      if (dist < 3.4 && this.pos.y < 2 && !this.busted && this.droneRamCd <= 0 && this.heat >= 1) {
        // Shove the PLAYER away from the drone (positive = away), not toward it.
        const away = toPlayer.clone().normalize().multiplyScalar(11)
        this.vel.add(away)
        this.heat = Math.min(5, this.heat + 0.5)
        this.shake = Math.min(this.shake + 0.35, 0.8)
        this.synth.thud()
        this.droneRamCd = 2.2
        if (this.ramToastCd <= 0) {
          this.hooks.onToast('DRONE RAMMED YOU — keep moving, don’t let them box you in!', 'warn')
          this.ramToastCd = 5
        }
      }
    }

    const speeding = sp > 0.85 * this.curTopSpeed
    const effNearest = Math.min(nearest, this.cruiserNearest)
    if (heatAllowed && speeding && effNearest < 45 && !this.busted) {
      this.heat = Math.min(5, this.heat + dt * 0.55)
    } else if (effNearest > 60 || !chased) {
      this.heat = Math.max(0, this.heat - dt * 0.28)
    }
    // First-ever chase stays a ★1 lesson, no matter what bumps into you
    if (firstEverChase && this.heat > 1.99) this.heat = 1.99

    // Explain the police game with toasts as heat changes
    const heatInt = Math.floor(this.heat)
    if (heatInt > this.lastHeatInt) {
      if (heatInt === 1) {
        this.hooks.onToast('PATROL ALERT ★ — you were spotted speeding!', 'warn')
        this.hooks.onToast('EVADE: keep your speed up and stay 60m+ from drones to cool down', 'info')
      } else if (heatInt === 3) {
        this.hooks.onToast('SIRENS ON ★★★ — drones are faster now. Do NOT stop!', 'warn')
      } else if (heatInt >= 4) {
        this.hooks.onToast('MAX HEAT ★★★★★ — break away or get fined!', 'warn')
      }
    } else if (heatInt === 0 && this.lastHeatInt >= 1) {
      this.hooks.onToast('You lost them. Heat cleared.', 'good')
      this.bumpGoal('escape')
      this.firstChaseDone = true // survived the first chase — full heat rules from here
    }
    this.lastHeatInt = heatInt

    // Busted meter: chased + slow + close (drones OR cruisers can box you in).
    // No grab during a player's first-ever chase — ★1 is the whole lesson.
    const grabbed = nearest < 5.5 || this.cruiserNearest < 5
    if (this.heat >= 1 && grabbed && sp < 9 && !this.busted && !firstEverChase) {
      this.bustedMeter += dt
      if (this.escapeHintCd <= 0) {
        this.hooks.onToast('BOXED IN — reverse + steer hard, or hit the handbrake to swing out!', 'info')
        this.escapeHintCd = 7
      }
      if (this.bustedMeter > 2.5) this.doBusted()
    } else {
      this.bustedMeter = Math.max(0, this.bustedMeter - dt * 0.9)
    }
  }

  private doBusted(): void {
    const save = this.hooks.getSave()
    const fine = Math.round(save.cash * 0.15)
    save.cash = Math.max(0, save.cash - fine)
    save.stats.busts += 1
    if (save.stats.busts >= 3) this.unlockAchievement('busted-3')
    this.hooks.commit()
    this.busted = true
    this.bustedCooldown = 2.6
    this.bustedMeter = 0
    this.heat = 0
    this.lastHeatInt = 0
    this.firstChaseDone = true
    this.synth.busted()
    this.hooks.onBusted()
    this.hooks.onToast(`BUSTED — Harbor Patrol impounded your ride. Fine: $${fine}`, 'warn')
    if (this.mission) this.hooks.onToast(`${this.mission.name} FAILED — caught mid-job, no payout`, 'warn')
    this.pos.set(this.garagePos.x, 0, this.garagePos.z + 19)
    this.vel.set(0, 0, 0)
    this.heading = Math.PI
    this.clearMission()
  }

  // =============== MISSIONS ===============
  /** Road point that respects district gates: resamples until the target lies in
      a district the player's level can enter (missions must always be reachable). */
  /** While a crew challenge is being laid out, its beacons stay in that district. */
  private missionDistrictHint: string | null = null
  private openPoint(rand: () => number, from: THREE.Vector3, dist: number): THREE.Vector3 {
    const save = this.hooks.getSave()
    const want = this.missionDistrictHint
    let p = roadPoint(rand, from, dist)
    // A district holds ~12 of the map's 100 junctions and the distance rule
    // rejects some of those, so a crew layout needs many more draws to stay home.
    for (let i = 0; i < (want ? 400 : 10); i++) {
      const d = districtAt(p.x, p.z)
      if (want ? d?.id === want : !d || save.level >= d.minLevel) return p
      p = roadPoint(rand, from, dist)
    }
    return p
  }

  /** Harbor Rides: cycle camera — near chase → far chase → in-car cockpit. */
  cycleCamera(): void {
    this.camMode = ((this.camMode + 1) % 3) as 0 | 1 | 2
    this.camDist = this.camMode === 1 ? 17 : 10
    if (this.carModel) this.carModel.visible = this.camMode !== 2
    this.hooks.onToast(this.camMode === 2 ? '🚗 In-car view — GPS on the dash' : this.camMode === 1 ? '📷 Camera: far' : '📷 Camera: near', 'info')
  }

  startMission(kind: 'delivery' | 'race' | 'taxi' | 'getaway', mods: ModId[] = [], rand: () => number = Math.random): void {
    const save = this.hooks.getSave()
    // Starting a new contract must never orphan the previous one's world props
    this.clearMission()
    this.synth.jobStart()
    this.missionStartT = this.time
    // ⚡ RUSH: the clock runs tighter (applied per mission shape below)
    const rush = mods.includes('rush') ? 0.7 : 1
    if (kind === 'delivery') {
      const a = this.openPoint(rand, this.pos, 50)
      const b = this.openPoint(rand, a, 90)
      const timer = Math.round((a.distanceTo(b) / 9 + 26) * rush)
      this.mission = { kind, stage: 'pickup', a, b, timer, name: `Courier Run ${save.stats.deliveries + 1}`, mods, damageHits: 0 }
      this.hooks.onToast('Courier contract accepted — reach the pickup beacon', 'good')
    } else if (kind === 'taxi') {
      const a = this.openPoint(rand, this.pos, 40)
      const b = this.openPoint(rand, a, 90)
      const timer = Math.round((a.distanceTo(b) / 8 + 30) * rush)
      const passenger = this.makePassenger(a)
      this.mission = { kind, stage: 'pickup', a, b, timer, name: `Taxi Fare ${save.stats.fares + 1}`, passenger, dist: a.distanceTo(b), mods, damageHits: 0, late: false }
      this.hooks.onToast('Fare waiting — pick up your passenger at the beacon', 'good')
    } else if (kind === 'getaway') {
      // The contract starts hot: Patrol is already hunting you. Survive until the heat dies.
      this.heat = Math.max(this.heat, 3.2)
      this.mission = { kind, heat0: 3.2, name: `Getaway Contract ${save.stats.getaways + 1}`, mods, damageHits: 0 }
      this.hooks.onToast('The Patrol is onto this run — lose them and stay lost!', 'warn')
    } else {
      const cps: THREE.Vector3[] = []
      let prev = this.pos.clone()
      for (let i = 0; i < 8; i++) {
        // Gates sit 55–150 m apart: far enough to race, never a cross-map
        // dash no clock could cover (a flat 14 s used to make some unwinnable).
        let cp = this.openPoint(rand, prev, 55)
        for (let t = 0; t < 30 && cp.distanceTo(prev) > 150; t++) cp = this.openPoint(rand, prev, 55)
        cps.push(cp)
        prev = cp
      }
      this.mission = { kind, cps, idx: 0, timer: gateSeconds(this.pos, cps[0], rush), total: 0, name: `Harbor GP ${save.stats.races + 1}`, mods, damageHits: 0 }
      this.hooks.onToast('Street race started — hit every gate before it closes!', 'good')
    }
    // 🔥 HOT CARGO: the run starts at ★1 — but only once the Patrol is awake
    // (new-player protection still holds; first-ever chase stays capped at ★1).
    if (mods.includes('hot') && kind !== 'getaway' && this.heatAllowed) {
      this.heat = Math.max(this.heat, 1.0)
      this.hooks.onToast('🔥 Hot cargo — the Patrol clocked this run already!', 'warn')
    }
    if (mods.length > 0) {
      this.hooks.onToast(`Contract terms: ${mods.map((mod) => `${MOD_INFO[mod].chip} — ${MOD_INFO[mod].blurb}`).join(' · ')}`, 'info')
    }
    this.synth.checkpoint()
  }

  /** A waiting passenger standing at the taxi pickup point (removed on pickup). */
  private makePassenger(at: THREE.Vector3): THREE.Group | null {
    const keys = Object.keys(this.assets.chars)
    if (keys.length === 0) return null
    const key = keys[Math.floor(Math.random() * keys.length)]
    const { obj } = cloneCharacter(this.assets, key)
    const bb = new THREE.Box3().setFromObject(obj)
    const h = bb.max.y - bb.min.y
    const s = h > 0.01 ? (1.6 + Math.random() * 0.25) / h : 1
    obj.scale.setScalar(s)
    obj.position.y = -bb.min.y * s
    const wrap = new THREE.Group()
    wrap.add(obj)
    wrap.position.set(at.x + 2.5, 0, at.z + 2.5)
    wrap.rotation.y = Math.random() * Math.PI * 2
    this.scene.add(wrap)
    return wrap
  }

  /** End any mission and clean up its world attachments (waiting passengers etc.). */
  /** The rival-crew challenge the current mission belongs to, if any. */
  private crewJob: { district: string; step: number } | null = null

  /** Set while the current mission is today's Daily Harbor Contract (its day key). */
  private dailyJob: string | null = null
  /** Final payout of the contract that just finished (the daily's score). */
  private lastPayout = 0

  /** The Daily Harbor Contract: one job per UTC day, laid out from a seed so
      every player gets the same job from the same start line at Garage 97.
      Score = the payout, so speed, Street Cred and heat all count. Replayable. */
  startDailyContract(): boolean {
    const day = dailyKey()
    if (!this.travelToDistrict('downtown')) return false
    let h = 2166136261
    for (let i = 0; i < day.length; i++) { h ^= day.charCodeAt(i); h = Math.imul(h, 16777619) }
    let a = h >>> 0
    const rand = (): number => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const kinds = ['delivery', 'taxi', 'race'] as const
    const kind = kinds[Math.floor(rand() * kinds.length)]
    const pool: ModId[] = kind === 'taxi' ? ['rush', 'vip'] : kind === 'race' ? ['rush', 'hot'] : ['rush', 'fragile', 'hot', 'clean']
    const first = pool[Math.floor(rand() * pool.length)]
    const rest = pool.filter((m) => m !== first)
    const mods: ModId[] = rand() < 0.5 && rest.length ? [first, rest[Math.floor(rand() * rest.length)]] : [first]
    this.startMission(kind, mods, rand)
    this.dailyJob = day
    if (this.mission) this.mission.name = `Daily Contract · ${day.slice(5)}`
    const best = this.hooks.getSave().daily
    this.hooks.onToast(
      `⭐ DAILY HARBOR CONTRACT — same job for every player today.${best.day === day && best.best > 0 ? ` Your best: $${best.best.toLocaleString()}` : ' Set your score.'}`,
      'good',
    )
    return true
  }

  // =============== WEEKLY HARBOR GP + GHOST ===============
  private missionStartT = 0
  /** Set while the current mission is this week's Harbor GP (its week key). */
  private weeklyJob: string | null = null
  private ghostMesh: THREE.Mesh | null = null
  /** x, z, heading triples at 10 Hz for the run in progress / the best run. */
  private ghostRec: number[] = []
  private ghostPlay: number[] | null = null
  private ghostAcc = 0
  private static readonly GHOST_KEY = 'neon-harbor-ghost-v1'

  /** The Weekly Harbor GP: one seeded 8-gate race per ISO week from the Garage
      97 start line — the same route for every player. Score = finish time.
      Your best run of the week races beside you as a ghost. */
  startWeeklyRace(): boolean {
    const key = weekKey()
    if (!this.travelToDistrict('downtown')) return false
    let h = 2166136261
    const seedStr = `gp:${key}`
    for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619) }
    let a = h >>> 0
    const rand = (): number => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    this.startMission('race', [], rand)
    this.weeklyJob = key
    if (this.mission) this.mission.name = `Weekly Harbor GP · ${key.slice(5)}`
    this.ghostRec = []
    this.ghostAcc = 0
    this.ghostPlay = null
    try {
      const raw = localStorage.getItem(GameEngine.GHOST_KEY)
      const g = raw ? (JSON.parse(raw) as { key?: string; s?: number[] }) : null
      if (g && g.key === key && Array.isArray(g.s) && g.s.length >= 6) this.ghostPlay = g.s
    } catch { /* no ghost — race alone */ }
    const w = this.hooks.getSave().weekly
    this.hooks.onToast(
      `🏁 WEEKLY HARBOR GP — same route for every player this week.${w.key === key && w.best > 0 ? ` Beat your ghost: ${w.best.toFixed(1)}s` : ' Set a time.'}`,
      'good',
    )
    return true
  }

  private weeklyOnMissionDone(): void {
    const key = this.weeklyJob
    if (!key) return
    const save = this.hooks.getSave()
    if (!save.weekly || save.weekly.key !== key) save.weekly = { key, best: 0, runs: 0 }
    save.weekly.runs += 1
    const secs = Math.round((this.time - this.missionStartT) * 100) / 100
    if (save.weekly.best === 0 || secs < save.weekly.best) {
      save.weekly.best = secs
      try { localStorage.setItem(GameEngine.GHOST_KEY, JSON.stringify({ key, t: secs, s: this.ghostRec })) } catch { /* storage full/blocked */ }
      this.hooks.onToast(`🏁 WEEKLY GP — new best: ${secs.toFixed(1)}s. Your ghost is waiting.`, 'good')
      this.hooks.onScore?.('weekly', key, secs)
    } else {
      this.hooks.onToast(`Weekly GP: ${secs.toFixed(1)}s — your best this week is ${save.weekly.best.toFixed(1)}s`, 'info')
    }
    this.hooks.onMilestone?.('weekly.complete.1')
    this.hooks.commit()
  }

  /** Records this run at 10 Hz and moves the ghost of the best run alongside. */
  private updateGhost(dt: number): void {
    if (!this.weeklyJob || !this.mission) {
      if (this.ghostMesh) this.ghostMesh.visible = false
      return
    }
    this.ghostAcc += dt
    while (this.ghostAcc >= 0.1) {
      this.ghostAcc -= 0.1
      if (this.ghostRec.length < 9000) {
        this.ghostRec.push(Math.round(this.pos.x * 100) / 100, Math.round(this.pos.z * 100) / 100, Math.round(this.heading * 1000) / 1000)
      }
    }
    const g = this.ghostPlay
    if (!g) return
    if (!this.ghostMesh) {
      this.ghostMesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.9, 0.9, 4.2),
        new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.3, depthWrite: false }),
      )
      this.scene.add(this.ghostMesh)
    }
    const f = (this.time - this.missionStartT) / 0.1
    const i = Math.floor(f)
    const n = g.length / 3
    if (i < 0 || i >= n - 1) {
      this.ghostMesh.visible = false
      return
    }
    const k = f - i
    const x = g[i * 3] + (g[i * 3 + 3] - g[i * 3]) * k
    const z = g[i * 3 + 1] + (g[i * 3 + 4] - g[i * 3 + 1]) * k
    this.ghostMesh.visible = true
    this.ghostMesh.position.set(x, 0.75, z)
    this.ghostMesh.rotation.y = g[i * 3 + 2]
  }

  private dailyOnMissionDone(): void {
    const day = this.dailyJob
    if (!day) return
    const save = this.hooks.getSave()
    if (!save.daily || save.daily.day !== day) save.daily = { day, best: 0, runs: 0 }
    save.daily.runs += 1
    const score = this.lastPayout
    if (score > save.daily.best) {
      save.daily.best = score
      this.hooks.onScore?.('daily', day, score)
      this.hooks.onToast(`⭐ DAILY CONTRACT — new best: $${score.toLocaleString()}. Run it again to beat it.`, 'good')
    } else {
      this.hooks.onToast(`Daily Contract: $${score.toLocaleString()} — your best today is $${save.daily.best.toLocaleString()}`, 'info')
    }
    this.hooks.onMilestone?.('daily.complete.1')
    this.hooks.commit()
  }

  /** Start the next challenge of the crew that holds `districtId`. The player
      is moved into the district first; the mission's beacons stay inside it. */
  startCrewChallenge(districtId: string): boolean {
    const crew = crewFor(districtId)
    const save = this.hooks.getSave()
    if (!crew) return false
    const step = crewRep(save.crews, districtId)
    if (step >= CREW_STEPS) {
      this.hooks.onToast(`${crew.name} already answer to you — this district is yours`, 'info')
      return false
    }
    if (!this.travelToDistrict(districtId)) return false
    const def = crew.steps[step]
    this.missionDistrictHint = districtId
    this.startMission(def.kind, [...def.mods])
    this.missionDistrictHint = null
    // startMission clears any previous mission (and with it the crew job),
    // so the job is tagged only after the new mission exists
    this.crewJob = { district: districtId, step }
    if (this.mission) this.mission.name = `${crew.name} ${step + 1}/${CREW_STEPS} — ${def.title}`
    this.hooks.onToast(`⚔️ ${crew.name.toUpperCase()} · ${def.title} — ${def.brief}`, 'warn')
    return true
  }

  /** A crew challenge was won: bank the step, and on the fifth take the district. */
  private crewOnMissionDone(): void {
    const job = this.crewJob
    if (!job) return
    const crew = crewFor(job.district)
    const save = this.hooks.getSave()
    if (!crew) return
    if (!save.crews) save.crews = {}
    // Only the next unbeaten step counts — replaying an old one changes nothing
    if (crewRep(save.crews, job.district) !== job.step) return
    save.crews[job.district] = job.step + 1
    this.hooks.onToast(crew.steps[job.step].win, 'good')
    this.grantXp(200)
    if (job.step + 1 >= CREW_STEPS) {
      const dName = DISTRICTS.find((d) => d.id === job.district)?.name ?? 'The district'
      this.grantCash(crew.takeoverCash)
      this.grantXp(800)
      this.synth.missionDone()
      this.hooks.onToast(`👑 ${dName.toUpperCase()} IS YOURS — ${crew.name} stand down. +$${crew.takeoverCash.toLocaleString()} · Home Turf +${Math.round(HOME_TURF_BONUS * 100)}% pay here`, 'good')
      this.hooks.onMilestone?.(`crew.${job.district}.taken`)
      if (districtsOwned(save.crews) >= 4) {
        this.hooks.onToast('🌃 THE WHOLE HARBOR IS YOURS — every crew answers to you. Legend.', 'good')
        this.hooks.onMilestone?.('crew.all')
      }
    } else {
      this.hooks.onToast(`${crew.name}: ${job.step + 1}/${CREW_STEPS} beaten — next challenge: Pause › Districts & Crews`, 'info')
    }
    this.hooks.commit()
  }

  private clearMission(): void {
    const m = this.mission
    if (m && m.kind === 'taxi' && m.passenger) this.scene.remove(m.passenger)
    this.crewJob = null
    this.dailyJob = null
    this.weeklyJob = null
    this.mission = null
    this.markerBeacon.visible = false
    this.credMissionBanked = 0 // contract-scoped cred bonus resets with the job
    this.missionPeakStars = 0
    // Harbor Rides: reset live ride state + hide route chevrons
    this.ride.violations = 0
    this.ride.clean = true
    this.ride.tipBonus = 0
    this.ride.speedT = 0
    this.ride.toastCd = 0
    for (const c of this.chevrons) c.visible = false
  }

  /** Harbor Rides: next-turn guidance for the HUD (↰/↱ + distance). */
  turnInfo: { dir: 'left' | 'right'; dist: number } | null = null

  /** Harbor Rides — per-frame ride gameplay: traffic violations that wake the
      Patrol, passenger reactions (drifts tip, crashes cost), on-road route
      chevrons and turn guidance. Runs every frame; cheap when no mission. */
  private updateRide(dt: number): void {
    const m = this.mission
    const t = m && (m.kind === 'delivery' || m.kind === 'taxi') ? (m.stage === 'pickup' ? m.a : m.b) : null
    const riding = !!m && m.kind === 'taxi' && m.stage === 'ride'

    // ---- route chevrons + turn prompt (any point-to-point mission) ----
    if (t && this.chevrons.length > 0) {
      const elbowOnRoad = this.isOnRoad(t.x, this.pos.z)
      const ex = elbowOnRoad ? t.x : this.pos.x
      const ez = elbowOnRoad ? this.pos.z : t.z
      // path: pos -> elbow -> target; walk fixed distances along it
      const seg1x = ex - this.pos.x, seg1z = ez - this.pos.z
      const len1 = Math.hypot(seg1x, seg1z)
      const seg2x = t.x - ex, seg2z = t.z - ez
      const len2 = Math.hypot(seg2x, seg2z)
      const total = len1 + len2
      const d1x = len1 > 0.01 ? seg1x / len1 : 0, d1z = len1 > 0.01 ? seg1z / len1 : 1
      const d2x = len2 > 0.01 ? seg2x / len2 : d1x, d2z = len2 > 0.01 ? seg2z / len2 : d1z
      const steps = this.lowPower ? [16, 34, 56] : [14, 26, 40, 56, 74]
      for (let i = 0; i < this.chevrons.length; i++) {
        const c = this.chevrons[i]
        const d = steps[i]
        if (d === undefined || d > total - 4 || total < 18) { c.visible = false; continue }
        const onSeg1 = d <= len1
        const px = onSeg1 ? this.pos.x + d1x * d : ex + d2x * (d - len1)
        const pz = onSeg1 ? this.pos.z + d1z * d : ez + d2z * (d - len1)
        const dx = onSeg1 ? d1x : d2x, dz = onSeg1 ? d1z : d2z
        c.position.set(px, 0.28, pz)
        c.rotation.y = Math.atan2(dx, dz) + Math.PI
        ;(c.material as THREE.MeshBasicMaterial).opacity = 0.30 + 0.28 * Math.sin(this.time * 4 - i * 0.7)
        c.visible = true
      }
      // turn prompt: approaching the elbow with a real direction change
      if (len1 > 14 && len1 < 170 && len2 > 8) {
        const hx = Math.sin(this.heading), hz = Math.cos(this.heading)
        const cross = hz * d2x - hx * d2z // y of heading × seg2
        if (Math.abs(cross) > 0.35) this.turnInfo = { dir: cross > 0 ? 'left' : 'right', dist: Math.round(len1) }
        else this.turnInfo = null
      } else this.turnInfo = null
    } else {
      for (const c of this.chevrons) c.visible = false
      this.turnInfo = null
    }

    if (!riding) return

    // ---- passenger reactions: drifts earn tips, crashes burn them ----
    this.ride.toastCd = Math.max(0, this.ride.toastCd - dt)
    if (this.drifting && !this.ride.wasDrifting && this.ride.tipBonus < 90) {
      this.ride.tipBonus += 15
      this.hooks.onToast('💨 “Nice drift!” +$15 tip', 'good')
    }
    this.ride.wasDrifting = this.drifting
    const dmgDelta = this.damage - this.ride.lastDamage
    if (dmgDelta > 3) {
      this.ride.tipBonus -= 20
      this.ride.violations += 0 // crash is its own penalty; not a traffic violation
      this.hooks.onToast('😱 “EASY!!” −$20 tip', 'warn')
    }
    this.ride.lastDamage = this.damage

    // ---- traffic violations (only while a fare is aboard) ----
    const sp = this.vel.length()
    const vx = this.vel.x, vz = this.vel.z
    const violate = (label: string): void => {
      if (this.ride.toastCd > 0) return
      this.ride.toastCd = 2.5
      this.ride.violations += 1
      this.ride.clean = false
      if (this.cruiserNearest < 100 && this.heatAllowed) {
        this.heat = Math.min(this.heat + 0.6, 5)
        this.hooks.onToast(`⚠ ${label} — PATROL TURNING ONTO YOU`, 'warn')
      } else {
        this.hooks.onToast(`${label} — no patrol saw it… this time`, 'info')
      }
    }
    // red-light running: crossing a lit junction against the phase
    const ph = this.time % 14
    for (let i = 0; i < this.lightIntersections.length && i < 4; i++) {
      this.ride.lightCd[i] = Math.max(0, this.ride.lightCd[i] - dt)
      const L = this.lightIntersections[i]
      if (!L || this.ride.lightCd[i] > 0 || sp < 9) continue
      if (Math.abs(this.pos.x - L.x) < 7 && Math.abs(this.pos.z - L.z) < 7) {
        const travelEW = Math.abs(vx) > Math.abs(vz)
        const red = travelEW ? ph >= 9.5 : ph < 9.5
        if (red) { this.ride.lightCd[i] = 8; violate('RED LIGHT RUN') }
      }
    }
    // speeding: holding >119 km/h inside the city for over a second
    if (sp > 33) {
      this.ride.speedT += dt
      if (this.ride.speedT > 1.2) { this.ride.speedT = -3; violate('SPEEDING') }
    } else {
      this.ride.speedT = Math.max(this.ride.speedT > 0 ? 0 : this.ride.speedT + dt, -3)
    }
  }

  cancelMission(): void {
    if (this.mission) {
      this.clearMission()
      this.hooks.onToast('Contract abandoned', 'warn')
    }
  }

  // =============== MAP CONTRACT MARKERS (Phase 1, step 3) ===============
  /** Roll a modifier set for a marker, gated by driver level: L1-2 get at most
      one (sometimes none — plain jobs while learning), L3+ get 1-2. */
  private rollMods(kind: Mission['kind'], level: number): ModId[] {
    const pool: ModId[] = ['fragile', 'clean']
    if (kind === 'taxi') pool.push('vip')
    if (kind !== 'getaway') pool.push('rush', 'hot')
    const count = level <= 2 ? (Math.random() < 0.5 ? 0 : 1) : 1 + (Math.random() < 0.4 ? 1 : 0)
    const mods: ModId[] = []
    for (let i = 0; i < count && pool.length > 0; i++) {
      const idx = Math.floor(Math.random() * pool.length)
      mods.push(pool.splice(idx, 1)[0])
    }
    return mods
  }

  /** Spawn one contract beacon on an open road point, ≥120 m from the others. */
  private spawnContractMarker(): void {
    const kinds: Mission['kind'][] = ['delivery', 'taxi', 'race', 'getaway']
    let kind = kinds[Math.floor(Math.random() * kinds.length)]
    // Avoid doubling a kind that's already on the map when a re-roll agrees
    if (this.contractMarkers.some((mk) => mk.kind === kind) && Math.random() < 0.7) {
      kind = kinds[Math.floor(Math.random() * kinds.length)]
    }
    let pos = this.openPoint(Math.random, this.pos, 60)
    for (let i = 0; i < 12; i++) {
      if (this.contractMarkers.every((mk) => mk.pos.distanceTo(pos) >= 120)) break
      pos = this.openPoint(Math.random, this.pos, 60)
    }
    const color = JOB_COLORS[kind]
    const group = new THREE.Group()
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 0.9, 18, 12, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.38, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    beam.position.y = 9
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.4, 2.1, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.15
    group.add(beam, ring)
    group.position.copy(pos)
    this.scene.add(group)
    const save = this.hooks.getSave()
    this.contractMarkers.push({
      id: ++this.markerSeq,
      kind,
      mods: this.rollMods(kind, save.level),
      pos,
      expiresAt: this.time + 180,
      mesh: group,
    })
  }

  private removeContractMarker(mk: ContractMarker): void {
    this.scene.remove(mk.mesh)
    this.contractMarkers = this.contractMarkers.filter((m) => m !== mk)
    if (this.nearMarker === mk) this.nearMarker = null
  }

  /** Take the job at the beacon you're standing in (E key / touch button). */
  private acceptMarker(): void {
    const mk = this.nearMarker
    if (!mk || this.mission) return
    this.removeContractMarker(mk)
    this.markerRespawnAt.push(this.time + 60)
    this.startMission(mk.kind, mk.mods)
  }

  private updateContractMarkers(): void {
    // Expire stale beacons; a replacement arrives 60 s later
    for (const mk of [...this.contractMarkers]) {
      if (this.time >= mk.expiresAt) {
        this.removeContractMarker(mk)
        this.markerRespawnAt.push(this.time + 60)
      }
    }
    this.markerRespawnAt = this.markerRespawnAt.filter((t) => {
      if (this.time >= t) {
        this.spawnContractMarker()
        return false
      }
      return true
    })
    // Safety net: the map never sits empty of work
    while (this.contractMarkers.length < 3 && this.markerRespawnAt.length === 0) {
      this.spawnContractMarker()
    }
    // Pulse animation + nearest-beacon detection (7 m accept radius)
    let nearest: ContractMarker | null = null
    let nearestD = 7
    for (const mk of this.contractMarkers) {
      const ring = mk.mesh.children[1]
      ring.scale.setScalar(1 + 0.18 * Math.sin(this.time * 3.5 + mk.id))
      const d = this.pos.distanceTo(mk.pos)
      if (d < nearestD) {
        nearest = mk
        nearestD = d
      }
    }
    this.nearMarker = nearest
    // One contract at a time: explain why the beacon won't take you right now
    if (nearest && this.mission && this.time > this.markerToastCd) {
      this.markerToastCd = this.time + 6
      this.hooks.onToast('Finish your current job first', 'warn')
    }
  }

  // =============== NIGHT SHIFT (Phase 1, step 4) ===============
  // 3 small goals per set, no expiry — a 5-minute visit still finishes
  // something. All 3 done → cash 250×level + 500 XP + a fresh set.
  private rollShiftGoals(level: number): ShiftGoal[] {
    // Chain goal scales with driver level (Claude's call: ×4 is too hard early)
    const chainNeed = level <= 2 ? 2 : level <= 4 ? 3 : 4
    const pool: ShiftGoal[] = [
      { id: 'chain', label: `Bank a ×${chainNeed} Street Cred chain`, target: 1, progress: 0, done: false },
      { id: 'fragile2', label: 'Finish 2 🥚 Fragile contracts', target: 2, progress: 0, done: false },
      { id: 'hot2star', label: 'Finish a contract at ★2+ heat', target: 1, progress: 0, done: false },
      { id: 'shards3', label: 'Collect 3 data shards', target: 3, progress: 0, done: false },
      { id: 'racefast', label: 'Win a street race under 100 s', target: 1, progress: 0, done: false },
      { id: 'jumps3', label: 'Stick 3 clean landings', target: 3, progress: 0, done: false },
      { id: 'escape', label: 'Escape a Patrol chase', target: 1, progress: 0, done: false },
    ]
    // 3 distinct goals per set
    const picks: ShiftGoal[] = []
    while (picks.length < 3 && pool.length > 0) {
      picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
    }
    return picks
  }

  /** Post a goal set if the save has none (first boot after the update). */
  private ensureShift(): void {
    const save = this.hooks.getSave()
    if (save.shift.goals.length === 0) {
      save.shift.goals = this.rollShiftGoals(save.level)
      this.hooks.commit()
    }
  }

  /** The chain multiplier this set's chain goal demands (∞ if no chain goal). */
  private shiftChainNeed(): number {
    const g = this.hooks.getSave().shift.goals.find((x) => x.id === 'chain' && !x.done)
    if (!g) return Infinity
    const m = /×(\d+)/.exec(g.label)
    return m ? parseInt(m[1], 10) : Infinity
  }

  /** Advance a shift goal; completing the whole set pays out and reposts. */
  private bumpGoal(id: string, by = 1): void {
    const save = this.hooks.getSave()
    const g = save.shift.goals.find((x) => x.id === id && !x.done)
    if (!g) return
    g.progress = Math.min(g.target, g.progress + by)
    if (g.progress >= g.target) {
      g.done = true
      this.hooks.onToast(`✅ SHIFT GOAL — ${g.label}`, 'good')
      this.synth.pickup()
    }
    if (save.shift.goals.every((x) => x.done)) {
      const bonus = 250 * save.level
      save.shift.completedCount += 1
      this.grantCash(bonus)
      this.grantXp(500)
      save.shift.goals = this.rollShiftGoals(save.level)
      this.synth.missionDone()
      this.hooks.onToast(`🌙 NIGHT SHIFT COMPLETE +$${bonus} +500 XP — new goals posted`, 'cash')
      const c = save.shift.completedCount
      if (c >= 1) this.hooks.onMilestone?.('shift.complete.1')
      if (c >= 5) this.hooks.onMilestone?.('shift.complete.5')
      if (c >= 20) this.hooks.onMilestone?.('shift.complete.20')
    }
    this.hooks.commit()
  }

  /** Contract-finish hooks shared by all four job types. */
  private shiftOnMissionDone(m: Mission): void {
    this.crewOnMissionDone()
    this.dailyOnMissionDone()
    this.weeklyOnMissionDone()
    if (this.missionPeakStars >= 2) this.bumpGoal('hot2star')
    if (this.missionPeakStars >= 3) this.hooks.onMilestone?.('heat.payout3')
    if (m.mods.includes('fragile')) {
      this.bumpGoal('fragile2')
      if (m.damageHits === 0) this.hooks.onMilestone?.('modifier.fragile.clean')
    }
  }

  // =============== HEAT PAYS (Phase 1, step 2) ===============
  /** Payout multiplier from the HIGHEST star level reached during the contract. */
  private heatPayMult(): number {
    const s = this.missionPeakStars
    return s <= 0 ? 1 : s === 1 ? 1.25 : s === 2 ? 1.5 : s === 3 ? 2 : 2.5
  }
  /** Cred payout bonus: +1% per 20 cred banked during the contract, cap +50%. */
  private credPayPct(): number {
    return Math.min(50, Math.floor(this.credMissionBanked / 20))
  }
  /** Final contract payout: base × modifier terms × heat × (1 + cred%).
      Fragile docks 10% per crash; Clean/VIP pay only on an undamaged run.
      Always shows the math so the payout never feels arbitrary. */
  private payContract(base: number): number {
    const m = this.mission
    const mods = m?.mods ?? []
    const hits = m?.damageHits ?? 0
    let effBase = base
    const parts = [`$${base} base`]
    // 🎩 VIP: an unharmed passenger doubles the leftover-time tip
    if (mods.includes('vip') && m && m.kind === 'taxi') {
      if (hits === 0) {
        const tip = Math.round(Math.max(0, m.timer) * 4)
        effBase += tip
        parts.push(`🎩VIP +$${tip}`)
      } else {
        parts.push('🎩VIP lost')
      }
    }
    let modMult = 1
    // Home Turf: contracts finished inside a district you took from its crew
    const here = districtAt(this.pos.x, this.pos.z)
    const homeTurf = !!here && districtOwned(this.hooks.getSave().crews, here.id)
    if (homeTurf) modMult += HOME_TURF_BONUS
    if (mods.includes('rush')) modMult += 0.5
    if (mods.includes('hot')) modMult += 0.3
    if (mods.includes('clean')) {
      if (hits === 0) modMult += 0.25
      else parts.push('🌙Clean lost')
    }
    const hm = this.heatPayMult()
    const cp = this.credPayPct()
    const fragileMul = mods.includes('fragile') ? Math.max(0, 1 - 0.1 * hits) : 1
    const final = Math.round(effBase * modMult * hm * (1 + cp / 100) * fragileMul)
    if (homeTurf) parts.push(`👑Home Turf +${Math.round(HOME_TURF_BONUS * 100)}%`)
    if (mods.includes('rush')) parts.push('⚡Rush +50%')
    if (mods.includes('hot')) parts.push('🔥Hot +30%')
    if (mods.includes('clean') && hits === 0) parts.push('🌙Clean +25%')
    if (hm > 1) parts.push(`×${hm} heat`)
    if (cp > 0) parts.push(`+${cp}% cred`)
    if (mods.includes('fragile')) parts.push(hits > 0 ? `🥚-${Math.min(100, hits * 10)}% bumps` : '🥚intact')
    this.lastPayout = final
    parts.push(`= $${final}`)
    this.hooks.onToast(parts.join(' '), 'cash')
    return final
  }

  private updateMission(dt: number): void {
    const m = this.mission
    if (!m) {
      this.markerBeacon.visible = false
      return
    }
    this.missionPeakStars = Math.max(this.missionPeakStars, Math.floor(this.heat))
    if (m.kind !== 'getaway') {
      m.timer -= dt
      if (m.timer <= 0) {
        // Harbor Rides: a late taxi never FAILS — the tip is lost, the fare
        // still pays on arrival. Frustration-free, consequence-kept.
        if (m.kind === 'taxi') {
          if (m.stage === 'ride' && !m.late) {
            m.late = true
            this.hooks.onToast('⏱ Out of time — tip lost. Base fare still pays at the drop.', 'warn')
          }
          m.timer = 0
        } else {
          this.hooks.onToast(`${m.name} — FAILED (out of time)`, 'warn')
          this.synth.denied()
          this.clearMission()
          return
        }
      }
    }
    if (m.kind === 'getaway') {
      // No beacon — the objective is the heat gauge itself. Stay free until it bleeds out.
      this.markerBeacon.visible = false
      if (this.heat < 0.8) {
        const reward = this.payContract(Math.round(300 + m.heat0 * 130))
        const save = this.hooks.getSave()
        save.stats.getaways += 1
        this.unlockAchievement('first-getaway')
        if (save.stats.getaways >= 5) this.unlockAchievement('getaway-5')
        this.grantCash(reward)
        this.grantXp(280)
        this.synth.missionDone()
        this.hooks.onMissionDone(m.name, reward)
        this.shiftOnMissionDone(m)
        this.clearMission()
      }
      return
    }
    if (m.kind === 'delivery' || m.kind === 'taxi') {
      const target = m.stage === 'pickup' ? m.a : m.b
      this.markerBeacon.position.set(target.x, 20, target.z)
      this.markerBeacon.visible = true
      if (this.pos.distanceTo(target) < 7.5) {
        if (m.stage === 'pickup') {
          m.stage = m.kind === 'taxi' ? 'ride' : 'deliver'
          if (m.kind === 'taxi' && m.passenger) {
            this.scene.remove(m.passenger)
            m.passenger = null
            // Harbor Rides: fresh fare — reset violations, tip drift, reactions
            this.ride.violations = 0
            this.ride.clean = true
            this.ride.tipBonus = 0
            this.ride.speedT = 0
            this.ride.lastDamage = this.damage
            m.late = false
          }
          this.synth.checkpoint()
          this.hooks.onToast(m.kind === 'taxi' ? 'Passenger aboard — beat the clock for the tip. Clean + fast pays DOUBLE.' : 'Package secured — now DELIVER it!', 'good')
        } else if (m.kind === 'delivery') {
          const reward = this.payContract(Math.round(200 + m.a.distanceTo(m.b) * 0.9 + m.timer * 5))
          const save = this.hooks.getSave()
          save.stats.deliveries += 1
          this.unlockAchievement('first-delivery')
          if (save.stats.deliveries >= 10) this.unlockAchievement('delivery-10')
          this.grantCash(reward)
          this.grantXp(150)
          this.synth.missionDone()
          this.hooks.onMissionDone(m.name, reward)
          this.shiftOnMissionDone(m)
          this.clearMission()
        } else {
          // Harbor Rides fare: base + distance always pays. The TIP pays only
          // if the clock is beaten — doubled when the ride stayed clean
          // (no red lights, no speeding) — plus live drift/scare adjustments.
          const onTime = !m.late && m.timer > 0
          let tip = onTime ? Math.round(m.timer * 4) + this.ride.tipBonus : 0
          if (onTime && this.ride.clean && tip > 0) tip *= 2
          tip = Math.max(0, Math.round(tip))
          const fare = this.payContract(Math.round(120 + m.dist * 0.8)) + tip
          const save = this.hooks.getSave()
          save.stats.fares += 1
          this.unlockAchievement('first-fare')
          this.grantCash(fare)
          this.grantXp(180)
          this.synth.missionDone()
          const tipNote = onTime
            ? this.ride.clean ? `clean & fast — tip DOUBLED +$${tip}` : `tip +$${tip}`
            : 'late — no tip'
          this.hooks.onToast(`Fare paid. ${tipNote}${this.ride.violations > 0 ? ` · ${this.ride.violations} violation${this.ride.violations > 1 ? 's' : ''}` : ''}`, onTime ? 'good' : 'info')
          this.hooks.onMissionDone(m.name, fare)
          this.shiftOnMissionDone(m)
          this.clearMission()
        }
      }
    } else {
      const cp = m.cps[m.idx]
      this.markerBeacon.position.set(cp.x, 20, cp.z)
      this.markerBeacon.visible = true
      if (this.pos.distanceTo(cp) < 8) {
        m.idx += 1
        m.total += m.timer
        // Each gate's clock follows the distance to it; ⚡ Rush runs 30% tighter
        if (m.idx < m.cps.length) m.timer = gateSeconds(cp, m.cps[m.idx], m.mods.includes('rush') ? 0.7 : 1)
        this.synth.checkpoint()
        if (m.idx >= m.cps.length) {
          const reward = this.payContract(Math.round(380 + m.total * 22))
          const save = this.hooks.getSave()
          save.stats.races += 1
          this.unlockAchievement('first-race')
          const raceTime = Math.round(this.time - this.missionStartT) // real elapsed seconds
          if (raceTime < 100) this.bumpGoal('racefast')
          if (!save.stats.bestRace || raceTime < save.stats.bestRace) save.stats.bestRace = raceTime
          this.grantCash(reward)
          this.grantXp(320)
          this.synth.missionDone()
          this.hooks.onMissionDone(m.name, reward)
          this.shiftOnMissionDone(m)
          this.clearMission()
        } else {
          this.hooks.onToast(`Gate ${m.idx}/8 — keep going!`, 'info')
        }
      }
    }
  }

  // =============== CAMERA / FX ===============
  private updateCamera(dt: number): void {
    if (this.attract) {
      // Cinematic orbit for the menus
      const ang = this.time * 0.07
      const target = new THREE.Vector3(Math.cos(ang) * 130, 58 + Math.sin(this.time * 0.18) * 10, Math.sin(ang) * 130)
      this.camera.position.lerp(target, 1 - Math.exp(-dt * 2))
      this.camera.lookAt(0, 8, 0)
      this.camera.fov += (58 - this.camera.fov) * Math.min(dt * 2, 1)
      this.camera.updateProjectionMatrix()
      return
    }
    if (this.wrecked) {
      // Kill-cam: slow push-in orbit around the burning wreck, tight FOV —
      // the player watches the car die instead of being ambushed by a card.
      const t = this.time * 0.55
      const side = new THREE.Vector3(Math.cos(t), 0, Math.sin(t))
      const target = this.pos.clone().addScaledVector(side, -7.5).add(new THREE.Vector3(0, 2.4, 0))
      this.camera.position.lerp(target, 1 - Math.exp(-dt * 2.4))
      this.camera.lookAt(this.pos.x, 1.1, this.pos.z)
      this.camera.fov += (44 - this.camera.fov) * Math.min(dt * 3, 1)
      this.camera.updateProjectionMatrix()
      return
    }
    const sp = this.vel.length()
    const dir = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))
    // cockpit hides the car body so it never blocks the windshield
    if (this.carModel) this.carModel.visible = this.camMode !== 2
    // ---- Harbor Rides: cockpit (in-car) camera. The car body would block the
    // view, so it hides while inside; chevrons + beacon carry navigation. ----
    if (this.camMode === 2) {
      const eye = this.pos.clone().addScaledVector(dir, 0.35).add(new THREE.Vector3(0, 1.32, 0))
      this.camera.position.lerp(eye, 1 - Math.exp(-dt * 14))
      const lookC = this.pos.clone().addScaledVector(dir, 14).add(new THREE.Vector3(0, 1.05, 0))
      if (this.shake > 0.01) {
        lookC.x += (Math.random() - 0.5) * this.shake * 0.7
        lookC.y += (Math.random() - 0.5) * this.shake * 0.7
        this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.3
      }
      // gentle speed bounce so the road feels alive
      this.camera.position.y += Math.sin(this.time * 9) * Math.min(sp * 0.0012, 0.02)
      this.camera.lookAt(lookC)
      const fovC = 68 + Math.min(sp * 0.5, 18) + (this.boosting ? 8 : 0)
      this.camera.fov += (fovC - this.camera.fov) * Math.min(dt * 4, 1)
      this.camera.updateProjectionMatrix()
      return
    }
    const target = this.pos.clone().addScaledVector(dir, -this.camDist).add(new THREE.Vector3(0, 4.4 + sp * 0.02, 0))
    this.camera.position.lerp(target, 1 - Math.exp(-dt * 5))
    const look = this.pos.clone().addScaledVector(dir, 7).add(new THREE.Vector3(0, 1.3, 0))
    if (this.shake > 0.01) {
      const s = this.shake
      look.x += (Math.random() - 0.5) * s
      look.y += (Math.random() - 0.5) * s
      this.camera.position.y += (Math.random() - 0.5) * s * 0.5
    }
    // Cinematic "arrival reveal": on entering a new city the camera drifts up
    // toward the hero landmark for ~2.3s, then eases back — fades out with speed
    // so it never fights the player mid-chase.
    if (this.zoneCamT > 0 && this.zoneLandmarkPos) {
      const w = Math.min(this.zoneCamT / 2.3, 1) * (1 - Math.min(sp / 50, 0.8))
      if (w > 0.01) {
        const lm = this.zoneLandmarkPos.clone().add(new THREE.Vector3(0, 55, 0))
        look.lerp(lm, w * 0.85)
        this.camera.position.y += w * 5.5
      }
      this.zoneCamT = Math.max(0, this.zoneCamT - dt)
    }
    this.camera.lookAt(look)
    const targetFov = 64 + Math.min(sp * 0.55, 26) + (this.boosting ? 10 : 0)
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(dt * 4, 1)
    this.camera.updateProjectionMatrix()
  }

  private updateTrail(): void {
    const sp = this.vel.length()
    if (sp > 8 && this.grounded) {
      this.trailHistory.unshift(this.pos.clone().setY(0.25))
      if (this.trailHistory.length > 30) this.trailHistory.pop()
    } else if (this.trailHistory.length > 0) {
      this.trailHistory.pop()
    }
    for (let i = 0; i < 30; i++) {
      const p = this.trailHistory.length ? this.trailHistory[Math.min(i, this.trailHistory.length - 1)] : null
      this.trailPos[i * 3] = p ? p.x : this.pos.x
      this.trailPos[i * 3 + 1] = p ? 0.22 : -50
      this.trailPos[i * 3 + 2] = p ? p.z : this.pos.z
    }
    this.trailGeom.attributes.position.needsUpdate = true
  }

  private updateRain(dt: number): void {
    if (!this.rain || !this.rainVel) return
    if (this.rain.visible) {
      const attr = this.rain.geometry.attributes.position as THREE.BufferAttribute
      const arr = attr.array as Float32Array
      for (let i = 0; i < this.rainVel.length; i++) {
        arr[i * 3 + 1] -= this.rainVel[i] * dt
        if (arr[i * 3 + 1] < 0) {
          arr[i * 3 + 1] = 55 + Math.random() * 5
          arr[i * 3] = this.pos.x + (Math.random() - 0.5) * 160
          arr[i * 3 + 2] = this.pos.z + (Math.random() - 0.5) * 160
        }
      }
      attr.needsUpdate = true
      // Expanding splash rings where drops hit the ground
      for (let i = 0; i < this.rainSplashes.length; i++) {
        const ring = this.rainSplashes[i]
        if (this.splashTimes[i] < 0) {
          if (Math.random() < dt * 7) {
            this.splashTimes[i] = 0
            ring.visible = true
            ring.position.set(this.pos.x + (Math.random() - 0.5) * 42, 0.04, this.pos.z + (Math.random() - 0.5) * 42)
            ring.scale.setScalar(0.4 + Math.random() * 0.5)
          }
        } else {
          this.splashTimes[i] += dt
          const life = 0.5
          if (this.splashTimes[i] > life) {
            this.splashTimes[i] = -1
            ring.visible = false
          } else {
            const k = this.splashTimes[i] / life
            ring.scale.set(ring.scale.x + dt * 2.2, ring.scale.y + dt * 2.2, 1)
            ;(ring.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.38
          }
        }
      }
    } else if (this.rainSplashes.length) {
      for (const ring of this.rainSplashes) ring.visible = false
      this.splashTimes.fill(-1)
    }
  }

  // =============== HUD / MINIMAP ===============
  private pushHud(): void {
    const save = this.hooks.getSave()
    let mission: HudMission | null = null
    if (this.mission) {
      const m = this.mission
      // Live risk–reward line on the mission card: current payout estimate
      // with the heat multiplier and cred bonus already applied.
      const base =
        m.kind === 'delivery' ? Math.round(200 + m.a.distanceTo(m.b) * 0.9 + m.timer * 5) :
        m.kind === 'taxi' ? Math.round(120 + m.dist * 0.8 + m.timer * 4) :
        m.kind === 'race' ? Math.round(380 + m.total * 22) :
        Math.round(300 + m.heat0 * 130)
      const payoutEst = Math.round(base * this.heatPayMult() * (1 + this.credPayPct() / 100))
      const live = { payoutEst, heatMult: this.heatPayMult(), credPct: this.credPayPct() }
      if (m.kind === 'delivery' || m.kind === 'taxi') {
        const t = m.stage === 'pickup' ? m.a : m.b
        mission = { kind: m.kind, name: m.name, timer: m.timer, dist: this.pos.distanceTo(t), stage: m.stage, ...live }
      } else if (m.kind === 'race') {
        const cp = m.cps[m.idx]
        mission = { kind: m.kind, name: m.name, timer: m.timer, dist: this.pos.distanceTo(cp), stage: `Gate ${m.idx + 1}/8`, ...live }
      } else {
        mission = { kind: m.kind, name: m.name, timer: -1, dist: 0, stage: `Heat ${Math.floor(this.heat)}★ — evade the Patrol!`, ...live }
      }
    }
    const chasedClose =
      this.cruiserNearest < 10 || this.drones.some((d) => d.pos.distanceTo(this.pos) < 13)

    // Sea animation + positional ambience (HUD rate; offsets are time-absolute,
    // so they stay smooth regardless of frame rate)
    if (this.waterTex) this.waterTex.offset.set(this.time * 0.012, this.time * 0.007)
    const edge = Math.max(Math.abs(this.pos.x), Math.abs(this.pos.z))
    const beach01 = THREE.MathUtils.clamp((edge - (HALF - 25)) / 45, 0, 1)
    const city01 = 1 - THREE.MathUtils.clamp(this.pos.length() / 170, 0, 1)
    this.synth.updateAmbience(beach01, city01, this.time)

    // First-night tutorial: runs once, T skips. Advances through TUTORIAL_STEPS.
    // Hidden AND frozen while the React onboarding tour is up — one onboarding
    // at a time, never two guides fighting on screen.
    let tutorial: HudState['tutorial'] = null
    if (!save.tutorialDone && !this.attract && !this.onboardingActive) {
      if (this.tutSnapShards < 0) {
        this.tutSnapShards = save.shards.length
        this.tutSnapDeliveries = save.stats.deliveries
        this.tutSnapRaces = save.stats.races
      }
      const spKmh = this.vel.length() * 3.6
      const steering = this.keys.has('a') || this.keys.has('d') || this.keys.has('arrowleft') || this.keys.has('arrowright')
      const checks = [
        spKmh > 5,
        spKmh > 8 && steering,
        this.boosting || this.boost < 95,
        this.drifting || this.driftScore > 20,
        this.nearGarage,
        this.mission !== null,
        save.shards.length > this.tutSnapShards ||
          save.stats.deliveries > this.tutSnapDeliveries ||
          save.stats.races > this.tutSnapRaces,
      ]
      let idx = 0
      while (idx < checks.length && checks[idx]) idx++
      if (idx >= checks.length) {
        save.tutorialDone = true
        this.hooks.commit()
        this.tutLastIdx = idx
        this.heatGraceUntil = this.time + 60
        this.hooks.onToast('Tutorial complete — the harbor is yours. Good luck out there!', 'good')
        this.hooks.onToast('The Patrol looks the other way for your first 60 seconds.', 'info')
      } else {
        if (this.tutLastIdx === -1) {
          this.hooks.onToast(
            this.uiTouch
              ? 'Welcome to Neon Harbor — the FIRST NIGHT guide rides on the right, under the map'
              : 'Welcome to Neon Harbor — follow the FIRST NIGHT card up top',
            'info',
          )
        } else if (idx !== this.tutLastIdx) {
          this.synth.pickup()
        }
        this.tutLastIdx = idx
        tutorial = { step: idx + 1, total: checks.length, title: TUTORIAL_STEPS[idx].title, hint: TUTORIAL_STEPS[idx].hint }
      }
    }

    this.hooks.onHud({
      speedKmh: Math.round(this.vel.length() * 3.6),
      cash: save.cash,
      xp: save.xp,
      level: save.level,
      xpNext: xpForLevel(save.level),
      heat: Math.round(this.heat * 10) / 10,
      heatStars: Math.floor(this.heat),
      bustedProgress: Math.min(this.bustedMeter / 2.5, 1),
      boost: Math.round(this.boost),
      shards: save.shards.length,
      totalShards: TOTAL_SHARDS,
      drift: Math.round(this.driftScore),
      chainMult: Math.round(this.chainMult() * 100) / 100,
      cred: this.credChain > 0
        ? { chain: Math.round(this.credChain), mult: this.credMult(), idle01: Math.max(0, Math.min(1, 1 - this.credIdle / 3)) }
        : null,
      pursued: this.heat >= 1 && !this.busted && chasedClose,
      tutorial,
      mission,
      marker: this.nearMarker && !this.mission
        ? { kind: this.nearMarker.kind, mods: this.nearMarker.mods.map((mod) => MOD_INFO[mod].chip) }
        : null,
      shift: save.tutorialDone
        ? {
            done: save.shift.goals.filter((g) => g.done).length,
            total: save.shift.goals.length,
            goals: save.shift.goals.map((g) => ({ label: g.label, progress: g.progress, target: g.target, done: g.done })),
          }
        : null,
      nearGarage: this.nearGarage,
      busted: this.busted,
      boosting: this.boosting,
      damage: Math.round(this.damage),
      wrecked: this.wrecked,
      lastHitKmh: this.lastHitKmh,
      lastHitCause: this.lastHitCause,
      stuck: (this.stuckTime > 2 || this.stuckLatch > 0) && !this.busted,
      zone: (() => {
        const z = zoneAt(this.worldKm)
        return { id: z.zone.id, name: z.zone.name, landmark: z.zone.landmark, unlockLevel: z.zone.unlockLevel, index: z.index, lap: z.lap, kmInto: z.kmInto, kmToNext: z.kmToNext }
      })(),
      worldKm: Math.round(this.worldKm * 10) / 10,
      breakdown: save.breakdown ?? null,
    })
  }

  private drawMinimapBase(): void {
    const c = this.mmBase
    const ctx = c.getContext('2d')
    if (!ctx) return
    const W = c.width
    const scale = W / (SIZE + 16)
    const toPx = (v: number) => (v + HALF + 8) * scale
    // Google Maps / AMap style: blue water, sandy beach ring, light city land,
    // white roads with a subtle casing — bright and readable at a glance.
    ctx.fillStyle = '#a8cbe4' // water
    ctx.fillRect(0, 0, W, W)
    ctx.fillStyle = '#ecdfae' // sand ring around the whole map edge
    ctx.fillRect(1, 1, W - 2, W - 2)
    ctx.fillStyle = '#e8e6df' // city land
    ctx.fillRect(toPx(-HALF - 4), toPx(-HALF - 4), (SIZE + 8) * scale, (SIZE + 8) * scale)
    ctx.fillStyle = '#dfdcd3' // city blocks, a shade darker so roads pop
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        ctx.fillRect(toPx(blockOrigin(i)), toPx(blockOrigin(j)), BLOCK * scale, BLOCK * scale)
      }
    }
    // Roads: grey casing then a white strip, on both axes
    for (let k = 0; k <= N; k++) {
      const rc = toPx(-HALF + ROAD / 2 + k * CELL)
      ctx.fillStyle = '#c9c6bd'
      ctx.fillRect(toPx(-HALF - 4), rc - ((ROAD + 2) / 2) * scale, (SIZE + 8) * scale, (ROAD + 2) * scale)
      ctx.fillRect(rc - ((ROAD + 2) / 2) * scale, toPx(-HALF - 4), (ROAD + 2) * scale, (SIZE + 8) * scale)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(toPx(-HALF - 4), rc - (ROAD / 2) * scale, (SIZE + 8) * scale, ROAD * scale)
      ctx.fillRect(rc - (ROAD / 2) * scale, toPx(-HALF - 4), ROAD * scale, (SIZE + 8) * scale)
    }
  }

  /** Current navigation objective: the live mission target, or the job garage
      while free-roaming. Getaway missions intentionally have no fixed target. */
  private navTarget(): THREE.Vector3 | null {
    if (!this.mission) return this.garagePos
    const m = this.mission
    if (m.kind === 'delivery' || m.kind === 'taxi') return m.stage === 'pickup' ? m.a : m.b
    if (m.kind === 'race') return m.cps[m.idx]
    return null
  }

  /** Route color as an rgb triplet — Google-Maps blue for every destination. */
  private navColor(): string {
    return '26,115,232'
  }

  private drawMinimap(): void {
    const ctx = this.mmCtx
    const W = this.mmCanvas.width
    ctx.clearRect(0, 0, W, W)
    ctx.drawImage(this.mmBase, 0, 0)
    const scale = W / (SIZE + 16)
    const toPx = (v: number) => (v + HALF + 8) * scale

    // ---- route guidance (Google-Maps style): an L-shaped grid route from the
    // car to the current objective, drawn under every marker. Cyan = garage,
    // yellow = live mission target. ----
    const rt = this.navTarget()
    if (rt) {
      const x0 = toPx(this.pos.x), z0 = toPx(this.pos.z)
      const x1 = toPx(rt.x), z1 = toPx(rt.z)
      // pick the elbow corner that lands on a road so the route hugs the grid
      const elbowRoad = this.isOnRoad(rt.x, this.pos.z)
      const ex = elbowRoad ? x1 : x0
      const ez = elbowRoad ? z0 : z1
      const rgb = this.navColor()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      // solid Google-style route: soft glow casing, then a solid blue line
      ctx.strokeStyle = `rgba(${rgb},0.28)`
      ctx.lineWidth = 7
      ctx.beginPath(); ctx.moveTo(x0, z0); ctx.lineTo(ex, ez); ctx.lineTo(x1, z1); ctx.stroke()
      ctx.strokeStyle = `rgba(${rgb},0.98)`
      ctx.lineWidth = 3.6
      ctx.beginPath(); ctx.moveTo(x0, z0); ctx.lineTo(ex, ez); ctx.lineTo(x1, z1); ctx.stroke()
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 4)
      ctx.strokeStyle = `rgba(${rgb},${0.45 + pulse * 0.45})`
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.arc(x1, z1, 4.5 + pulse * 2.5, 0, Math.PI * 2)
      ctx.stroke()
    }

    if (this.mission) {
      const m = this.mission
      let t: THREE.Vector3 | null = null
      if (m.kind === 'delivery' || m.kind === 'taxi') t = m.stage === 'pickup' ? m.a : m.b
      else if (m.kind === 'race') t = m.cps[m.idx]
      // getaway: no fixed target — the patrol dots on the HUD carry the info
      if (t) {
        // Google-style red destination pin (teardrop)
        const px = toPx(t.x)
        const pz = toPx(t.z)
        ctx.fillStyle = '#ea4335'
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.arc(px, pz - 4, 3.6, Math.PI * 0.85, Math.PI * 0.15)
        ctx.lineTo(px, pz + 3.4)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        ctx.arc(px, pz - 4, 1.3, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    // Garage: green Maps-style square with white border
    ctx.fillStyle = '#34a853'
    ctx.fillRect(toPx(this.garagePos.x) - 3, toPx(this.garagePos.z) - 3, 6, 6)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.2
    ctx.strokeRect(toPx(this.garagePos.x) - 3, toPx(this.garagePos.z) - 3, 6, 6)
    // exploration: shards (tiny cyan), crates (green), landmarks (purple diamonds)
    ctx.fillStyle = '#67e8f9'
    for (const s of this.shards) {
      if (!s.taken) ctx.fillRect(toPx(s.mesh.position.x) - 1, toPx(s.mesh.position.z) - 1, 2, 2)
    }
    ctx.fillStyle = '#4ade80'
    for (const c of this.crates) {
      if (c.active) ctx.fillRect(toPx(c.mesh.position.x) - 1.5, toPx(c.mesh.position.z) - 1.5, 3, 3)
    }
    for (const lm of this.landmarks) {
      ctx.fillStyle = lm.found ? '#3b3b5c' : '#c084fc'
      const px = toPx(lm.pos.x)
      const pz = toPx(lm.pos.z)
      ctx.beginPath()
      ctx.moveTo(px, pz - 3.5)
      ctx.lineTo(px + 3.5, pz)
      ctx.lineTo(px, pz + 3.5)
      ctx.lineTo(px - 3.5, pz)
      ctx.closePath()
      ctx.fill()
    }
    // contract beacons: job-colored dots, dimmed while a mission is running
    for (const mk of this.contractMarkers) {
      const hex = JOB_COLORS[mk.kind].toString(16).padStart(6, '0')
      const px = toPx(mk.pos.x)
      const pz = toPx(mk.pos.z)
      ctx.fillStyle = `#${hex}${this.mission ? '66' : 'ff'}`
      ctx.beginPath()
      ctx.arc(px, pz, 3, 0, Math.PI * 2)
      ctx.fill()
      if (!this.mission) {
        ctx.strokeStyle = `#${hex}88`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(px, pz, 4.5 + 1.5 * Math.sin(this.time * 3.5 + mk.id), 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    ctx.fillStyle = '#ff3355'
    for (const d of this.drones) {
      ctx.beginPath()
      ctx.arc(toPx(d.pos.x), toPx(d.pos.z), 2.4, 0, Math.PI * 2)
      ctx.fill()
    }
    // Patrol cruisers: flashing red/blue dots while heat is on, with a pulsing
    // heat zone ring around the nearest unit so the threat area reads at a glance
    if (this.heat > 0.5 && this.cruisers.length > 0) {
      const flash = Math.floor(this.time * 4) % 2 === 0
      let nearest: { x: number; z: number } | null = null
      let nearestD = Infinity
      for (const c of this.cruisers) {
        const px = toPx(c.pos.x)
        const pz = toPx(c.pos.z)
        ctx.fillStyle = flash ? '#ff3355' : '#3b82f6'
        ctx.beginPath()
        ctx.arc(px, pz, 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.75)'
        ctx.lineWidth = 0.8
        ctx.stroke()
        const dd = (c.pos.x - this.pos.x) ** 2 + (c.pos.z - this.pos.z) ** 2
        if (dd < nearestD) {
          nearestD = dd
          nearest = { x: px, z: pz }
        }
      }
      if (nearest && this.heat >= 2) {
        const pulse = 0.5 + 0.5 * Math.sin(this.time * 3.2)
        ctx.strokeStyle = `rgba(255,51,85,${0.25 + pulse * 0.35})`
        ctx.lineWidth = 1.6
        ctx.beginPath()
        ctx.arc(nearest.x, nearest.z, (26 + this.heat * 9) * scale, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    ctx.save()
    ctx.translate(toPx(this.pos.x), toPx(this.pos.z))
    ctx.rotate(Math.atan2(Math.sin(this.heading), Math.cos(this.heading)))
    // translucent heading cone, Google-Maps style
    ctx.fillStyle = 'rgba(26,115,232,0.28)'
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.arc(0, 0, 15, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
    // blue dot with a white ring
    ctx.fillStyle = '#1a73e8'
    ctx.beginPath()
    ctx.arc(toPx(this.pos.x), toPx(this.pos.z), 4.6, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.stroke()
  }

  /** AMap / Google-Maps style big map (opened by tapping the minimap). Bright
      and readable: blue water, sand ring, white roads, yellow avenues, named
      districts — redrawn live while open so it doubles as a navigation HUD. */
  drawTacMap(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const S = canvas.width
    const EXT = 258 // city half-size (205) + beach strip
    const scale = S / (EXT * 2)
    const toPx = (v: number) => (v + EXT) * scale
    const save = this.hooks.getSave()
    const fs = (r: number) => `${Math.max(S * r, 9)}px system-ui, sans-serif`

    // ---- terrain: ocean, full sand ring, city land (AMap palette) ----
    ctx.fillStyle = '#a8cbe4' // water
    ctx.fillRect(0, 0, S, S)
    ctx.fillStyle = '#ecdfae' // beach sand ring on every side
    ctx.fillRect(toPx(-HALF - 46), toPx(-HALF - 46), (2 * (HALF + 46)) * scale, (2 * (HALF + 46)) * scale)
    ctx.fillStyle = '#e8e6df' // city land
    ctx.fillRect(toPx(-HALF - ROAD), toPx(-HALF - ROAD), (SIZE + ROAD * 2) * scale, (SIZE + ROAD * 2) * scale)

    // ---- roads: grey casing, then white fill (AMap look) ----
    const rc = (k: number) => -HALF + k * CELL + ROAD / 2 // road centerline
    ctx.lineCap = 'butt'
    for (let k = 0; k <= N; k++) {
      const p = toPx(rc(k))
      ctx.strokeStyle = '#c9c6bd'
      ctx.lineWidth = (ROAD + 2) * scale
      ctx.beginPath(); ctx.moveTo(p, toPx(-HALF)); ctx.lineTo(p, toPx(HALF)); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(toPx(-HALF), p); ctx.lineTo(toPx(HALF), p); ctx.stroke()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = ROAD * scale
      ctx.beginPath(); ctx.moveTo(p, toPx(-HALF)); ctx.lineTo(p, toPx(HALF)); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(toPx(-HALF), p); ctx.lineTo(toPx(HALF), p); ctx.stroke()
    }
    // the two central avenues — AMap arterial yellow
    for (const c of [rc(4), rc(5)]) {
      const p = toPx(c)
      ctx.strokeStyle = '#eec04a'
      ctx.lineWidth = ROAD * scale * 0.62
      ctx.beginPath(); ctx.moveTo(p, toPx(-HALF)); ctx.lineTo(p, toPx(HALF)); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(toPx(-HALF), p); ctx.lineTo(toPx(HALF), p); ctx.stroke()
    }
    // south bridge stub across the sand toward the lighthouse
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 16 * scale
    ctx.beginPath(); ctx.moveTo(toPx(0), toPx(HALF)); ctx.lineTo(toPx(0), toPx(HALF + 46)); ctx.stroke()

    // ---- city blocks + subtle grid labels ----
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        // skip the cells roads already painted: blocks sit between roads
        ctx.fillStyle = i === GARAGE_I && j === GARAGE_J ? '#d4e6d7' : '#dfdcd3'
        ctx.fillRect(toPx(blockOrigin(i)), toPx(blockOrigin(j)), BLOCK * scale, BLOCK * scale)
      }
      const c = toPx(blockOrigin(i) + BLOCK / 2)
      ctx.fillStyle = '#a9aeab'
      ctx.font = fs(0.02)
      ctx.fillText(String.fromCharCode(65 + i), c, S * 0.018)
      ctx.fillText(String(i + 1), S * 0.018, c)
    }

    // ---- districts: soft tints with dark AMap-style labels + level locks ----
    const TINTS = ['rgba(34,211,238,0.10)', 'rgba(167,139,250,0.10)', 'rgba(74,222,128,0.10)', 'rgba(251,191,36,0.12)', 'rgba(244,114,182,0.10)']
    DISTRICTS.forEach((d, idx) => {
      const locked = save.level < d.minLevel
      const crew = crewFor(d.id)
      const owned = districtOwned(save.crews, d.id)
      const x = toPx(d.minX), y = toPx(d.minZ)
      const w = (d.maxX - d.minX) * scale, h = (d.maxZ - d.minZ) * scale
      // Taken districts glow in the player's underglow colour
      const mine = `#${getSkin(save.skin).glow.toString(16).padStart(6, '0')}`
      ctx.fillStyle = owned ? mine : locked ? 'rgba(255,51,85,0.08)' : TINTS[idx % TINTS.length]
      ctx.globalAlpha = owned ? 0.22 : 1
      ctx.fillRect(x, y, w, h)
      ctx.globalAlpha = 1
      ctx.strokeStyle = owned ? mine : crew ? crew.color : locked ? 'rgba(220,60,90,0.5)' : 'rgba(100,116,139,0.35)'
      ctx.lineWidth = Math.max(S * (owned ? 0.004 : crew ? 0.0025 : 0.0012), 1)
      ctx.setLineDash([S * 0.012, S * 0.008])
      ctx.strokeRect(x, y, w, h)
      ctx.setLineDash([])
      // white pill behind the name so it reads over any terrain, AMap-style
      const label = locked
        ? `\u{1F512} ${d.name.toUpperCase()} \u00b7 LVL ${d.minLevel}`
        : owned
          ? `\u{1F451} ${d.name.toUpperCase()} \u00b7 YOURS`
          : crew
            ? `${d.name.toUpperCase()} \u00b7 ${crew.name.toUpperCase()} ${crewRep(save.crews, d.id)}/${CREW_STEPS}`
            : d.name.toUpperCase()
      ctx.font = `bold ${Math.max(S * 0.02, 9)}px system-ui, sans-serif`
      const tw = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      const pw = tw + S * 0.016, ph = S * 0.028
      ctx.beginPath()
      ctx.roundRect(x + w / 2 - pw / 2, y + h / 2 - ph / 2, pw, ph, ph / 2)
      ctx.fill()
      ctx.fillStyle = locked ? '#c23152' : '#40506b'
      ctx.fillText(label, x + w / 2, y + h / 2 + S * 0.001)
    })

    // ---- navigation route (Google-Maps blue): bold glow underlay + solid
    // line, with a distance pill at the destination. ----
    const navT = this.navTarget()
    if (navT) {
      const x0 = toPx(this.pos.x), z0 = toPx(this.pos.z)
      const x1 = toPx(navT.x), z1 = toPx(navT.z)
      const elbowRoad = this.isOnRoad(navT.x, this.pos.z)
      const ex = elbowRoad ? x1 : x0
      const ez = elbowRoad ? z0 : z1
      const rgb = this.navColor()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = `rgba(${rgb},0.3)`
      ctx.lineWidth = Math.max(S * 0.014, 4)
      ctx.beginPath(); ctx.moveTo(x0, z0); ctx.lineTo(ex, ez); ctx.lineTo(x1, z1); ctx.stroke()
      ctx.strokeStyle = `rgba(${rgb},0.95)`
      ctx.lineWidth = Math.max(S * 0.006, 2)
      ctx.beginPath(); ctx.moveTo(x0, z0); ctx.lineTo(ex, ez); ctx.lineTo(x1, z1); ctx.stroke()
      const dist = `${Math.round(Math.hypot(navT.x - this.pos.x, navT.z - this.pos.z))}m`
      ctx.font = `bold ${Math.max(S * 0.017, 9)}px system-ui, sans-serif`
      const dw = ctx.measureText(dist).width + S * 0.014
      ctx.fillStyle = `rgba(${rgb},1)`
      ctx.beginPath()
      ctx.roundRect(x1 - dw / 2, z1 + S * 0.02, dw, S * 0.026, S * 0.013)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.fillText(dist, x1, z1 + S * 0.02 + S * 0.013)
    }

    // ---- points of interest ----
    const dot = (x: number, z: number, r: number, color: string) => {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(toPx(x), toPx(z), r, 0, Math.PI * 2)
      ctx.fill()
    }
    // garage / job board — Maps green square with label
    const gx = toPx(this.garagePos.x), gz = toPx(this.garagePos.z)
    ctx.fillStyle = '#34a853'
    ctx.fillRect(gx - S * 0.008, gz - S * 0.008, S * 0.016, S * 0.016)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = Math.max(S * 0.0015, 1)
    ctx.strokeRect(gx - S * 0.008, gz - S * 0.008, S * 0.016, S * 0.016)
    ctx.font = `bold ${Math.max(S * 0.017, 9)}px system-ui, sans-serif`
    ctx.fillStyle = '#2b7a43'
    ctx.fillText('JOBS', gx, gz - S * 0.02)
    // mission target — Maps red pin
    if (this.mission) {
      const m = this.mission
      let t: THREE.Vector3 | null = null
      if (m.kind === 'delivery' || m.kind === 'taxi') t = m.stage === 'pickup' ? m.a : m.b
      else if (m.kind === 'race') t = m.cps[m.idx]
      if (t) {
        dot(t.x, t.z, S * 0.011, '#ea4335')
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = Math.max(S * 0.002, 1.2)
        ctx.beginPath()
        ctx.arc(toPx(t.x), toPx(t.z), S * 0.011, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = '#b3321f'
        ctx.font = `bold ${Math.max(S * 0.017, 9)}px system-ui, sans-serif`
        ctx.fillText(m.name.toUpperCase(), toPx(t.x), toPx(t.z) - S * 0.026)
      }
    }
    for (const s of this.shards) if (!s.taken) dot(s.mesh.position.x, s.mesh.position.z, Math.max(S * 0.003, 1.2), '#0891b2')
    for (const c of this.crates) if (c.active) dot(c.mesh.position.x, c.mesh.position.z, Math.max(S * 0.004, 1.6), '#16a34a')
    // Street pickups (v2): nitro cyan-blue, repair pale green, cash amber
    for (const p of this.pickups) if (p.active) dot(p.mesh.position.x, p.mesh.position.z, Math.max(S * 0.004, 1.6), p.kind === 'nitro' ? '#38bdf8' : p.kind === 'repair' ? '#86efac' : '#fbbf24')
    for (const lm of this.landmarks) {
      ctx.fillStyle = lm.found ? '#9aa3b2' : '#9333ea'
      const px = toPx(lm.pos.x), pz = toPx(lm.pos.z), r = S * 0.007
      ctx.beginPath()
      ctx.moveTo(px, pz - r); ctx.lineTo(px + r, pz); ctx.lineTo(px, pz + r); ctx.lineTo(px - r, pz)
      ctx.closePath(); ctx.fill()
    }
    for (const d of this.drones) dot(d.pos.x, d.pos.z, Math.max(S * 0.004, 1.6), '#dc2645')
    if (this.heat > 0.5 && this.cruisers.length > 0) {
      const flash = Math.floor(this.time * 4) % 2 === 0
      let nearest: { x: number; z: number } | null = null
      let nearestD = Infinity
      for (const c of this.cruisers) {
        dot(c.pos.x, c.pos.z, S * 0.009, flash ? '#ff3355' : '#3b82f6')
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.lineWidth = Math.max(S * 0.0015, 1)
        ctx.beginPath()
        ctx.arc(toPx(c.pos.x), toPx(c.pos.z), S * 0.009, 0, Math.PI * 2)
        ctx.stroke()
        const dd = (c.pos.x - this.pos.x) ** 2 + (c.pos.z - this.pos.z) ** 2
        if (dd < nearestD) { nearestD = dd; nearest = c.pos }
      }
      if (nearest && this.heat >= 2) {
        ctx.strokeStyle = 'rgba(220,38,69,0.55)'
        ctx.lineWidth = Math.max(S * 0.002, 1.2)
        ctx.beginPath()
        ctx.arc(toPx(nearest.x), toPx(nearest.z), (26 + this.heat * 9) * scale, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // ---- player: Google-style heading cone + blue dot (map: x right, z down) ----
    const px = toPx(this.pos.x), pz = toPx(this.pos.z)
    const hd = Math.atan2(Math.sin(this.heading), Math.cos(this.heading))
    const face = Math.atan2(Math.cos(hd), Math.sin(hd)) // polar angle of the facing vector on canvas
    ctx.fillStyle = 'rgba(26,115,232,0.25)'
    ctx.beginPath()
    ctx.moveTo(px, pz)
    ctx.arc(px, pz, S * 0.09, face - 0.5, face + 0.5)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#1a73e8'
    ctx.beginPath()
    ctx.arc(px, pz, S * 0.009, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = Math.max(S * 0.0025, 1.5)
    ctx.stroke()

    // ---- frame, compass, legend ----
    ctx.strokeStyle = 'rgba(71,85,105,0.5)'
    ctx.lineWidth = Math.max(S * 0.002, 1.5)
    ctx.strokeRect(S * 0.035, S * 0.035, S * 0.93, S * 0.93)
    ctx.fillStyle = '#40506b'
    ctx.font = `bold ${Math.max(S * 0.026, 11)}px system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.fillText('\u2191 N', S * 0.045, S * 0.062)
    ctx.textAlign = 'center'
    ctx.fillText('NEON HARBOR \u2014 CITY MAP', S / 2, S * 0.965)
    ctx.font = fs(0.018)
    ctx.fillStyle = '#6b7a95'
    ctx.fillText('YOU \u25cf   JOBS \u25a0   MISSION \u25cf   SHARDS \u00b7   CRATES \u00b7   LANDMARKS \u25c6   PATROL \u25cf', S / 2, S * 0.985)
  }

  // =============== PUBLIC CONTROLS ===============
  setPaused(p: boolean): void {
    this.paused = p
    if (p) this.keys.clear()
  }

  setAttract(on: boolean): void {
    this.attract = on
    if (!on) {
      // Snap camera behind the car for a clean transition
      const dir = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))
      this.camera.position.copy(this.pos.clone().addScaledVector(dir, -this.camDist).add(new THREE.Vector3(0, 4.4, 0)))
    }
  }

  setMuted(m: boolean): void {
    this.synth.setMuted(m)
  }

  /** Suspend all audio (vplay.gg host pause / tab hidden). */
  suspendAudio(): void {
    this.synth.suspend()
  }

  /** Resume audio after a host pause. */
  resumeAudio(): void {
    this.synth.resume()
  }

  /** Debug/test helper: teleport the car (used by the ?autostart&at= screenshot checks). */
  debugTeleport(x: number, z: number, heading = 0): void {
    this.pos.set(x, 0, z)
    this.vel.set(0, 0, 0)
    this.heading = heading
    // Snap the camera behind the car instantly (headless test frames don't run
    // enough rAF ticks for the smooth follow to converge)
    const dir = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading))
    this.camera.position.copy(
      this.pos.clone().addScaledVector(dir, -this.camDist).add(new THREE.Vector3(0, 4.4, 0))
    )
  }

  startAudio(): void {
    this.synth.start()
  }

  playBuy(): void {
    this.synth.buy()
  }

  playDenied(): void {
    this.synth.denied()
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.resize)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.synth.dispose()
    this.composer.dispose()
    this.renderer.dispose()
  }

  // =============== POLICE CRUISERS ===============
  private cruiserNearest = 999

  private spawnCruisers(): void {
    const rand = seededRand(60613)
    for (let k = 0; k < 3; k++) {
      const g = new THREE.Group()
      const body = cloneCar(this.assets, 'police')
      const bb = new THREE.Box3().setFromObject(body)
      const len = bb.max.z - bb.min.z
      const s = len > 0.01 ? 4.6 / len : 1
      body.scale.setScalar(s)
      body.position.y = -bb.min.y * s
      g.add(body)
      const roofY = bb.max.y * s
      const black = new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 0.5, metalness: 0.6 })
      // Light bar
      const barBase = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.1, 0.4), black)
      barBase.position.set(0, roofY + 0.05, -0.15)
      const barL = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.36), new THREE.MeshBasicMaterial({ color: 0xff2233 }))
      barL.position.set(-0.33, roofY + 0.18, -0.15)
      const barR = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.36), new THREE.MeshBasicMaterial({ color: 0x2244ff }))
      barR.position.set(0.33, roofY + 0.18, -0.15)
      const hl = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.14, 0.06), new THREE.MeshBasicMaterial({ color: 0xeaf4ff }))
      hl.position.set(0, 0.52, bb.max.z * s + 0.03)
      const tl = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.14, 0.06), new THREE.MeshBasicMaterial({ color: 0xff3344 }))
      tl.position.set(0, 0.52, bb.min.z * s - 0.03)
      g.add(barBase, barL, barR, hl, tl)
      const axis: 'x' | 'z' = rand() > 0.5 ? 'x' : 'z'
      const laneIdx = Math.floor(rand() * (N + 1))
      const lane = -HALF + ROAD / 2 + laneIdx * CELL - 2.6
      const dir: 1 | -1 = rand() > 0.5 ? 1 : -1
      const along = (rand() * 2 - 1) * HALF
      if (axis === 'x') {
        g.position.set(along, 0, lane)
        g.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2
      } else {
        g.position.set(lane, 0, along)
        g.rotation.y = dir > 0 ? 0 : Math.PI
      }
      this.scene.add(g)
      this.cruisers.push({
        mesh: g, barL, barR,
        pos: g.position.clone(),
        vel: new THREE.Vector3(),
        wp: roadPoint(rand),
        heading: g.rotation.y,
        bob: rand() * 10,
      })
    }
  }

  private updateCruisers(dt: number): void {
    this.cruiserNearest = 999
    const flash = Math.floor(this.time * 2.5) % 2 === 0
    const active = this.heat >= 2
    for (const c of this.cruisers) {
      // Flashing light bars
      ;(c.barL.material as THREE.MeshBasicMaterial).color.setHex(flash ? 0xff3355 : 0x550f16)
      ;(c.barR.material as THREE.MeshBasicMaterial).color.setHex(flash ? 0x111d66 : 0x5577ff)

      // Chase steering: accelerate along axis toward the player's along-coordinate
      const toPlayer = new THREE.Vector3().subVectors(this.pos, c.pos)
      toPlayer.y = 0
      const dist = toPlayer.length()
      this.cruiserNearest = Math.min(this.cruiserNearest, dist)
      this.trackTail(c, dist)
      // Near-miss on patrol cars too (same anti-farm rules as traffic)
      const cSpeed = 9
      const cRelKmh = Math.hypot(this.vel.x - Math.sin(c.heading) * cSpeed, this.vel.z - Math.cos(c.heading) * cSpeed) * 3.6
      const nmReady = (this.cruiserNmCd.get(c) ?? 0) <= this.time
      if (nmReady && dist > 2.4 && dist < 5.4 && this.vel.length() * 3.6 > 60 && cRelKmh > 40) {
        this.cruiserNmCd.set(c, this.time + 3)
        this.addCred(25)
        this.synth.checkpoint()
      }

      let speed = 9
      if (active && dist < 140) {
        speed = 15 + this.heat * 2.5
        // Steer toward player: blend axis alignment
        const desired = Math.atan2(toPlayer.x, toPlayer.z)
        let diff = desired - c.heading
        while (diff > Math.PI) diff -= Math.PI * 2
        while (diff < -Math.PI) diff += Math.PI * 2
        c.heading += THREE.MathUtils.clamp(diff, -1.4 * dt, 1.4 * dt)
      } else {
        // Gentle patrol wander
        c.heading += Math.sin(this.time * 0.4 + c.bob) * 0.12 * dt
      }
      const fwd = new THREE.Vector3(Math.sin(c.heading), 0, Math.cos(c.heading))
      // Keep cruisers from plowing through blocks: nudge heading along roads when inside a block
      const rx = ((c.pos.x + HALF) % CELL + CELL) % CELL
      const rz = ((c.pos.z + HALF) % CELL + CELL) % CELL
      const onRoadX = rx < ROAD || rz < ROAD
      if (!onRoadX) {
        // rotate toward nearest axis direction
        const snap = Math.abs(Math.sin(c.heading)) > Math.abs(Math.cos(c.heading)) ? Math.PI / 2 : 0
        const snapped = Math.sin(c.heading) * Math.cos(snap) >= 0 ? snap : -snap
        let diff2 = snapped - c.heading
        while (diff2 > Math.PI) diff2 -= Math.PI * 2
        while (diff2 < -Math.PI) diff2 += Math.PI * 2
        c.heading += diff2 * Math.min(dt * 4, 1)
      }
      c.pos.addScaledVector(fwd, speed * dt)
      // Soft world bounds
      const L = HALF + 2
      c.pos.x = THREE.MathUtils.clamp(c.pos.x, -L, L)
      c.pos.z = THREE.MathUtils.clamp(c.pos.z, -L, L)
      c.mesh.position.copy(c.pos)
      c.mesh.rotation.y = c.heading

      // Separation: cruisers hold a small gap so they push you, not swallow you.
      if (dist < 2.8) {
        c.pos.add(toPlayer.clone().normalize().multiplyScalar(-(2.8 - dist)))
      }
      // Ram the player — shove AWAY (positive), never toward the cruiser.
      if (dist < 3.3 && this.pos.y < 2 && !this.busted && this.cruiserRamCd <= 0 && this.heat >= 1) {
        const away = toPlayer.clone().normalize().multiplyScalar(9)
        this.vel.add(away)
        this.heat = Math.min(5, this.heat + 0.45)
        this.shake = Math.min(this.shake + 0.3, 0.8)
        this.synth.thud()
        this.cruiserRamCd = 2.6
        if (this.ramToastCd <= 0) {
          this.hooks.onToast('CRUISER HIT YOU — outrun them above ~120 km/h or break line of sight!', 'warn')
          this.ramToastCd = 5
        }
      }
    }
  }

  // =============== SMOKE & SPARKS ===============
  private initSmoke(): void {
    const tex = makeGlowTexture()
    for (let i = 0; i < 40; i++) {
      const mat = new THREE.SpriteMaterial({ map: tex, color: 0x99a3b8, transparent: true, opacity: 0, depthWrite: false })
      const sprite = new THREE.Sprite(mat)
      sprite.visible = false
      this.scene.add(sprite)
      this.smoke.push({ sprite, life: 0, max: 0.7 })
    }
  }

  private emitPuff(x: number, y: number, z: number, color: number, size: number, maxLife: number, additive: boolean): void {
    const slot = this.smoke.find((s) => s.life <= 0)
    if (!slot) return
    slot.life = maxLife
    slot.max = maxLife
    slot.sprite.visible = true
    slot.sprite.position.set(x, y, z)
    slot.sprite.scale.set(size, size, 1)
    const m = slot.sprite.material as THREE.SpriteMaterial
    m.color.setHex(color)
    m.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending
    m.opacity = additive ? 0.9 : 0.35
  }

  private updateSmoke(dt: number): void {
    for (const s of this.smoke) {
      if (s.life <= 0) continue
      s.life -= dt
      if (s.life <= 0) {
        s.sprite.visible = false
        continue
      }
      const t = s.life / s.max
      const m = s.sprite.material as THREE.SpriteMaterial
      m.opacity = (m.blending === THREE.AdditiveBlending ? 0.9 : 0.35) * t
      const grow = 1 + (1 - t) * 2.2
      s.sprite.scale.set(s.sprite.scale.x * (1 + dt * 2), s.sprite.scale.y * (1 + dt * 2), 1)
      void grow
      s.sprite.position.y += dt * 0.8
    }
  }

  // =============== STREET CRED CHAIN ===============
  private chainMult(): number {
    return 1 + Math.min(this.chainCount, 8) * 0.25
  }

  private addChain(base: number, label: string): number {
    const mult = this.chainMult()
    const pay = Math.round(base * mult)
    this.chainCount += 1
    this.chainTimer = 8
    this.grantCash(pay)
    const multTxt = mult > 1 ? `  ×${mult.toFixed(2)}` : ''
    this.hooks.onToast(`${label} +$${pay}${multTxt}`, 'cash')
    if (this.chainCount > 1) this.synth.chainUp()
    return pay
  }

  // =============== STREET CRED (Phase 1) ===============
  /** Current style multiplier: ×1, then ×2..×5 as the unbanked chain passes
      100 / 250 / 500 / 900 cred. */
  private credMult(): number {
    let m = 1
    for (const t of CRED_STEPS) if (this.credChain >= t) m += 1
    return m
  }

  /** Add RAW style points to the chain (the multiplier steps on raw cred and
      is applied once, at bank time — score × multiplier, no snowballing).
      Steady drift = 20 raw/s → ×2 at 5 s, ×3 at 12.5 s, ×4 at 25 s, ×5 at 45 s.
      Every award resets the 3s bank timer. Stepping up pops a toast (max 1 per 2s). */
  private addCred(base: number): void {
    if (base <= 0 || this.attract) return
    const before = this.credMult()
    this.credChain += Math.round(base)
    this.credIdle = 0
    const now = this.credMult()
    if (now > before && this.credPopCd <= 0) {
      this.credPopCd = 2
      this.hooks.onToast(`×${now} STREET CRED!`, 'good')
      this.synth.chainUp()
    }
    // vplay.gg milestones: first ×3 and ×5 chains (per save)
    if (now >= 3) this.hooks.onMilestone?.('cred.x3')
    if (now >= 5) this.hooks.onMilestone?.('cred.x5')
  }

  /** 3s without a style action banks the chain: XP (1:1 on a contract, 1:2
      free-roam with the 400 XP / 10 min anti-farm cap) + lifetime stat. */
  private bankCred(): void {
    const raw = Math.round(this.credChain)
    const mult = this.credMult()
    this.credChain = 0
    this.credIdle = 0
    if (raw < 10) return
    const banked = raw * mult
    const save = this.hooks.getSave()
    save.stats.cred += banked
    let xp = banked
    if (this.mission) {
      this.credMissionBanked += banked
    } else {
      // Free-roam anti-farm: 1:2 XP, max 400 XP per 10 real minutes. The
      // window lives in the save on the wall clock, so a reload can't reset it.
      xp = Math.round(banked / 2)
      const cap = save.credCap
      const now = Date.now()
      if (now - cap.windowStartMs > 600_000 || now < cap.windowStartMs) {
        cap.windowStartMs = now
        cap.xpUsed = 0
      }
      xp = Math.min(xp, Math.max(0, 400 - cap.xpUsed))
      cap.xpUsed += xp
    }
    if (xp > 0) this.grantXp(xp)
    if (mult >= this.shiftChainNeed()) this.bumpGoal('chain')
    this.hooks.commit()
    const math = mult > 1 ? `${raw} ×${mult} = ${banked}` : `+${banked}`
    this.hooks.onToast(`CRED BANKED ${math}${xp > 0 ? ` → +${xp} XP` : ' (free-roam cap)'}`, 'good')
  }

  /** Any damage breaks the chain — the unbanked cred is lost. */
  private breakCred(): void {
    if (this.credChain >= 100) this.hooks.onToast(`CHAIN BROKEN — ${Math.round(this.credChain)} cred lost`, 'warn')
    this.credChain = 0
    this.credIdle = 0
  }

  /** Per-frame cred upkeep: 0.5s style ticks, idle banking, pop cooldown. */
  private updateCred(dt: number): void {
    this.credPopCd = Math.max(0, this.credPopCd - dt)
    if (this.attract || this.paused || this.wrecked) return
    const kmh = this.vel.length() * 3.6
    this.credTickAcc += dt
    while (this.credTickAcc >= 0.5) {
      this.credTickAcc -= 0.5
      if (this.drifting && kmh > 40) this.addCred(10)
      if (this.boosting && this.vel.length() >= 0.9 * this.curTopSpeed) this.addCred(5)
    }
    // Airtime: raw cred accrues per 0.5s airborne; a clean landing doubles it
    if (!this.grounded) {
      this.jumpAirAcc += dt
      while (this.jumpAirAcc >= 0.5) {
        this.jumpAirAcc -= 0.5
        this.jumpCred += 15
      }
    }
    if (this.credChain > 0) {
      this.credIdle += dt
      if (this.credIdle >= 3) this.bankCred()
    }
  }

  /** Landing handler (called from updateCar when the wheels touch down). */
  private landJumpCred(): void {
    if (this.jumpCred > 0) {
      if (!this.jumpDamaged) {
        this.jumpCred *= 2 // clean landing doubles the jump
        this.bumpGoal('jumps3')
      }
      this.addCred(this.jumpCred)
    }
    this.jumpCred = 0
    this.jumpAirAcc = 0
    this.jumpDamaged = false
  }

  /** "Shake a tail": a chaser that got within 25 m in the last 5 s and falls
      back beyond 60 m pays 50 cred — once per chaser per chase. */
  private trackTail(chaser: object, dist: number): void {
    let rec = this.tailTrack.get(chaser)
    if (!rec) {
      rec = { closeT: -9999, counted: false }
      this.tailTrack.set(chaser, rec)
    }
    if (this.heat < 1) {
      rec.counted = false
      rec.closeT = -9999
      return
    }
    if (dist < 25) rec.closeT = this.time
    if (!rec.counted && rec.closeT > 0 && this.time - rec.closeT <= 5 && dist > 60) {
      rec.counted = true
      this.addCred(50)
      this.hooks.onToast('TAIL SHAKEN +50 cred', 'cash')
    }
  }

  // =============== PEDESTRIANS ===============
  private makeDog(): THREE.Group {
    const g = new THREE.Group()
    const coat = new THREE.MeshStandardMaterial({ color: 0x5f4527, roughness: 0.85 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x3f2e1c, roughness: 0.85 })
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.24, 0.66), coat)
    body.position.y = 0.36
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, 0.22), dark)
    head.position.set(0, 0.44, 0.36)
    const snout = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.14), coat)
    snout.position.set(0, 0.38, 0.5)
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.26, 0.06), dark)
    tail.position.set(0, 0.55, -0.32)
    tail.rotation.x = 0.55
    const legGeo = new THREE.BoxGeometry(0.09, 0.28, 0.09)
    for (const [lx, lz] of [[-0.13, 0.22], [0.13, 0.22], [-0.13, -0.22], [0.13, -0.22]]) {
      const leg = new THREE.Mesh(legGeo, dark)
      leg.position.set(lx, 0.14, lz)
      g.add(leg)
    }
    g.add(body, head, snout, tail)
    return g
  }

  private spawnPedestrians(): void {
    // Phones: half the crowd — every walker is a skinned, animated character
    const STREET = this.lowPower ? 44 : 88
    const BEACH = this.lowPower ? 20 : 42
    const rand = seededRand(4321)
    const charKeys = Object.keys(this.assets.chars)
    if (charKeys.length === 0) return
    // Vibrant Night City crowd (QA brief 2026-10-12): real skin-tone variety,
    // colorful street-wear from the brief's palette (teal, mustard, coral,
    // orange, cream, denim, burgundy, lavender, olive), kids + seniors — and a
    // faint self-glow on every material so people separate from the dark city.
    const SKIN_TONES = [0xf2c9a0, 0xe8b98d, 0xd0a075, 0xb07d52, 0x8a5a38, 0x6b4226]
    const SHIRTS = [0x2a9d8f, 0xd4a017, 0xff7f6b, 0xe76f51, 0xf1e3d3, 0x4a6fa5, 0x7b2d43, 0x9b8ac4, 0x6b7f4e, 0x3a86c8]
    const KID_SHIRTS = [0xd4a017, 0xff7f6b, 0xe76f51, 0xf1e3d3, 0x48a9a6, 0x9b8ac4]
    const PANTS = [0x3b4a63, 0x2f3542, 0x4a6fa5, 0x5b4a3a, 0x6b7f4e, 0x8a93a6]
    const HAIR = [0x1d1512, 0x3b2a1e, 0x5a4230, 0x8a6d4b, 0x2b2b30]
    const GREY_HAIR = [0xb9b3ad, 0xd8d2ca, 0x9aa0a5]
    const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]
    for (let i = 0; i < STREET + BEACH; i++) {
      const beach = i >= STREET
      const key = charKeys[Math.floor(rand() * charKeys.length)]
      const { obj, clips } = cloneCharacter(this.assets, key)
      // Crowd mix: ~12% kids (1.12–1.38m, bright jackets), ~10% seniors
      // (shorter, grey hair where the model has a hair material), rest adults.
      const kid = rand() < 0.12
      const senior = !kid && rand() < 0.11
      const bb = new THREE.Box3().setFromObject(obj)
      const h = bb.max.y - bb.min.y
      const targetH = kid ? 1.12 + rand() * 0.26 : senior ? 1.55 + rand() * 0.15 : 1.58 + rand() * 0.37
      const s = h > 0.01 ? targetH / h : 1
      obj.scale.setScalar(s)
      // Semantic tinting: Quaternius cast has named materials (Skin/Shirt/
      // Pants/Hair…); the Kenney kit splits body/head; single-mesh models get
      // one vibrant outfit tint. Slight brightness jitter kills the clone-stamp.
      const skin = new THREE.Color(pick(SKIN_TONES))
      const shirt = new THREE.Color(kid ? pick(KID_SHIRTS) : pick(SHIRTS))
      const pants = new THREE.Color(pick(PANTS))
      const hair = new THREE.Color(senior ? pick(GREY_HAIR) : pick(HAIR))
      const jitter = 0.9 + rand() * 0.25
      // v2.1 zone crowd: keep the shirt material + base colour so each city
      // can re-tint the whole street toward its own wardrobe on arrival.
      const shirtMats: THREE.MeshStandardMaterial[] = []
      const baseShirt = shirt.clone().multiplyScalar(jitter)
      obj.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        const src = m.material as THREE.MeshStandardMaterial
        const mat = src.clone()
        const label = `${src.name} ${m.name}`.toLowerCase()
        let tint: THREE.Color
        if (/skin|head/.test(label)) tint = skin
        else if (/hair/.test(label)) tint = hair
        else if (/pant|trouser|skirt|shorts/.test(label)) tint = pants
        else if (/eye/.test(label)) tint = new THREE.Color(0x2b2b2b)
        else if (/shoe|sock/.test(label)) tint = kid ? new THREE.Color(0xe8e8e8) : pants
        else if (/shirt|top|jacket|body/.test(label)) { tint = shirt; shirtMats.push(mat) }
        else { tint = shirt; shirtMats.push(mat) }
        mat.color = tint.clone().multiplyScalar(jitter)
        // Cool night separation: a whisper of self-glow in the material's own
        // hue (cheap stand-in for rim light — no extra lights for 130 peds).
        mat.emissive = tint.clone().multiplyScalar(0.16)
        m.material = mat
      })
      const wrap = new THREE.Group()
      obj.position.y = -bb.min.y * s
      wrap.add(obj)
      // NOTE: ped shadows are intentionally off — 100+ skinned characters in the
      // shadow pass more than doubles frame cost for a subtle visual gain
      const mixer = new THREE.AnimationMixer(obj)
      const walkClip =
        clips.find((c) => c.name.toLowerCase() === 'walk') ??
        clips.find((c) => c.name.toLowerCase().includes('walk')) ??
        clips[0]
      const walk = mixer.clipAction(walkClip)
      walk.play()
      // Optional idle clip powers the "stop to check phone" street behavior
      const idleClip = clips.find((c) => /idle|stand/i.test(c.name))
      const idle = idleClip ? mixer.clipAction(idleClip) : null
      let axis: 'x' | 'z'
      let lane: number
      let px: number
      let pz: number
      if (beach) {
        // Strollers on the sand ring: they wander the shore line and turn back inland
        axis = rand() > 0.5 ? 'x' : 'z'
        lane = (rand() > 0.5 ? 1 : -1) * (HALF + 8 + rand() * 26)
        const along = (rand() * 2 - 1) * (HALF + 4)
        px = axis === 'x' ? along : lane
        pz = axis === 'x' ? lane : along
      } else {
        axis = rand() > 0.5 ? 'x' : 'z'
        const laneIdx = Math.floor(rand() * (N + 1))
        const c = -HALF + ROAD / 2 + laneIdx * CELL
        const off = (rand() > 0.5 ? 1 : -1) * (ROAD / 2 + 1.5)
        lane = c + off
        px = axis === 'x' ? (rand() * 2 - 1) * (HALF - 10) : lane
        pz = axis === 'x' ? lane : (rand() * 2 - 1) * (HALF - 10)
      }
      const baseSpeed = 1.1 + rand() * 0.9
      wrap.position.set(px, 0, pz)
      this.scene.add(wrap)
      const ped = {
        x: wrap.position.x,
        z: wrap.position.z,
        axis,
        dir: (rand() > 0.5 ? 1 : -1) as 1 | -1,
        speed: baseSpeed,
        baseSpeed,
        mesh: wrap,
        mixer,
        walk,
        idle,
        state:  0 as 0,
        ht: 0,
        hvx: 0,
        hvz: 0,
        hvy: 0,
        hspin: 0,
        beach,
        crossing: 0,
        returnAxis: axis,
        pausing: false,
        pauseLeft: 0,
        pauseT: 4 + rand() * 14,
        glanceT: 0,
        panicT: 0,
        dog: undefined as THREE.Group | undefined,
        shirtMats,
        baseShirt,
      }
      // Evening beach life: some strollers take a dog out (low-poly pup trots beside)
      if (beach && rand() < 0.45) {
        const dog = this.makeDog()
        dog.position.set(0.55, 0, -0.2)
        wrap.add(dog)
        ped.dog = dog
      }
      this.peds.push(ped)
    }
  }

  private updatePedestrians(dt: number): void {
    for (const p of this.peds) {
      if (p.state === 1) {
        // Knocked down: tumble with real momentum, come to rest, then respawn elsewhere
        p.ht += dt
        p.hvy -= 14 * dt
        p.x += p.hvx * dt
        p.z += p.hvz * dt
        let y = p.mesh.position.y + p.hvy * dt
        if (y <= 0) {
          y = 0
          p.hvy = 0
          p.hvx *= Math.max(0, 1 - 6 * dt)
          p.hvz *= Math.max(0, 1 - 6 * dt)
        }
        p.mesh.position.set(p.x, y, p.z)
        if (p.dog) {
          const w = Math.sin(this.time * 5 + p.x * 0.61 + p.z * 0.23)
          p.dog.position.y = 0.05 * Math.abs(w)
          p.dog.rotation.z = w * 0.1
        }
        p.mesh.rotation.x = Math.min(p.mesh.rotation.x + p.hspin * dt, Math.PI / 2)
        if (p.ht > 3.5) {
          // Respawn on a fresh sidewalk spot, far from the accident
          const axis: 'x' | 'z' = Math.random() > 0.5 ? 'x' : 'z'
          const laneIdx = Math.floor(Math.random() * (N + 1))
          const c = -HALF + ROAD / 2 + laneIdx * CELL
          const off = (Math.random() > 0.5 ? 1 : -1) * (ROAD / 2 + 1.5)
          const lane = c + off
          p.axis = axis
          p.x = axis === 'x' ? (Math.random() * 2 - 1) * (HALF - 10) : lane
          p.z = axis === 'x' ? lane : (Math.random() * 2 - 1) * (HALF - 10)
          p.dir = Math.random() > 0.5 ? 1 : -1
          p.crossing = 0
          p.state = 0
          p.pausing = false
          p.pauseLeft = 0
          p.panicT = 0
          p.pauseT = 4 + Math.random() * 14
          p.mesh.position.set(p.x, 0, p.z)
          p.mesh.rotation.x = 0
          p.idle?.stop()
          p.walk.reset().play()
        }
        continue
      }
      // Sprint away from a moving car
      const dx = p.x - this.pos.x
      const dz = p.z - this.pos.z
      const d2 = dx * dx + dz * dz
      const carSpeed = this.vel.length()
      const speed = (d2 < 49 && carSpeed > 4 ? 5 : p.baseSpeed) * (p.glanceT > 0 ? 0.35 : 1)
      // Horn panic: dive straight away from the car for a couple of seconds
      if (p.panicT > 0) {
        p.panicT -= dt
        const d = Math.sqrt(d2) || 1
        p.x += (dx / d) * 5.5 * dt
        p.z += (dz / d) * 5.5 * dt
        const lim = HALF + 40
        p.x = Math.max(-lim, Math.min(lim, p.x))
        p.z = Math.max(-lim, Math.min(lim, p.z))
        p.pausing = false
        p.walk.timeScale = 1.7
        this.tickMixer(p.mixer, p.mesh, p.x, p.z, dt)
        p.mesh.position.set(p.x, 0, p.z)
        p.mesh.rotation.y = Math.atan2(dx, dz)
        continue
      }
      let hold = false
      // Life behavior: pause and "check phone" at quiet spots, then move on
      if (p.idle) {
        if (!p.pausing && p.crossing <= 0 && carSpeed <= 4 && d2 > 64) {
          p.pauseT -= dt
          if (p.pauseT <= 0) {
            p.pausing = true
            p.pauseLeft = 1.5 + Math.random() * 3
            p.walk.fadeOut(0.25)
            p.idle.reset().fadeIn(0.25).play()
          }
        } else if (p.pausing) {
          p.pauseLeft -= dt
          if (p.pauseLeft <= 0) {
            p.pausing = false
            p.pauseT = 6 + Math.random() * 14
            p.idle.fadeOut(0.25)
            p.walk.reset().fadeIn(0.25).play()
          }
        }
      }
      if (!p.beach) {
        if (p.crossing > 0) {
          // Mid-crossing at a zebra: commit and finish, signal or not
          p.crossing -= speed * dt
          if (p.crossing <= 0) p.axis = p.returnAxis
        } else {
          // At the signalled crossroads: wait on the curb for the walk signal,
          // then cross the road perpendicular to the sidewalk
          const along = p.axis === 'x' ? p.x : p.z
          const ph = this.time % 14
          for (const li of this.lightIntersections) {
            const c = p.axis === 'x' ? li.x : li.z
            const d = (c - along) * p.dir
            if (d > 0 && d < 2.5) {
              const crossAxis: 'x' | 'z' = p.axis === 'x' ? 'z' : 'x'
              // Walk signal = the traffic we cross is on RED (EW red ph>=8; NS red ph<9.5 or >=12.5)
              const signalOk = crossAxis === 'x' ? ph < 9.5 || ph >= 12.5 : ph >= 8
              if (!signalOk) hold = true
              else if (Math.random() < dt * 0.7) {
                p.returnAxis = p.axis
                p.axis = crossAxis
                p.dir = Math.random() > 0.5 ? 1 : -1
                p.crossing = ROAD + 3.2
              }
              break
            }
          }
        }
      }
      if (!hold && !p.pausing) {
        const step = speed * dt * p.dir
        if (p.axis === 'x') p.x += step
        else p.z += step
      }
      if (p.crossing <= 0) {
        if (p.beach) {
          // Strollers stay on the sand: turn at the water line and at the promenade edge
          const along = p.axis === 'x' ? p.x : p.z
          const across = p.axis === 'x' ? p.z : p.x
          const limA = HALF + 42
          if (along > limA || along < -limA) p.dir = along > limA ? -1 : 1
          if (Math.abs(across) < HALF + 7) p.dir = across > 0 ? 1 : -1
        } else {
          const lim = HALF - 6
          if (p.axis === 'x' && (p.x > lim || p.x < -lim)) p.dir = p.x > lim ? -1 : 1
          if (p.axis === 'z' && (p.z > lim || p.z < -lim)) p.dir = p.z > lim ? -1 : 1
        }
      }
      // Walk-animation pace follows actual speed
      p.walk.timeScale = 0.6 + (speed / 1.8) * 0.8
      this.tickMixer(p.mixer, p.mesh, p.x, p.z, dt)
      p.mesh.position.set(p.x, 0, p.z)
      // Startled glance: face a fast-approaching car for a beat, then carry on
      p.glanceT = Math.max(0, p.glanceT - dt)
      if (d2 < 120 && carSpeed > 7) p.glanceT = 0.9
      p.mesh.rotation.y = p.glanceT > 0
        ? Math.atan2(dx, dz)
        : p.axis === 'x' ? (p.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (p.dir > 0 ? 0 : Math.PI)
      // Hit by the car: knocked flying, patrol alerted
      if (d2 < 2.1 && carSpeed > 4 && this.pos.y < 1.5) {
        p.state = 1
        p.ht = 0
        const dir = this.vel.clone().setY(0).normalize()
        p.hvx = dir.x * (3 + carSpeed * 0.35)
        p.hvz = dir.z * (3 + carSpeed * 0.35)
        p.hvy = 4.5
        p.hspin = (Math.random() > 0.5 ? 1 : -1) * (4 + Math.random() * 4)
        p.walk.stop()
        p.idle?.stop()
        p.pausing = false
        this.lastHitKmh = Math.round(this.vel.length() * 3.6)
        this.lastHitCause = 'a pedestrian'
        this.vel.multiplyScalar(0.82)
        this.shake = Math.min(this.shake + 0.35, 0.8)
        if (this.heatAllowed) {
          this.heat = Math.min(5, this.heat + 1)
          this.hooks.onToast('You hit a pedestrian! Patrol alerted (+1★)', 'warn')
        } else {
          this.hooks.onToast('You hit a pedestrian! Watch it — the Patrol won’t ignore that for long.', 'warn')
        }
        this.synth.thud()
        this.addDamage(3)
        this.speakPanic(true)
      }
    }
  }

  // =============== SUPPLY CRATES ===============
  private spawnCrates(): void {
    const geom = new THREE.BoxGeometry(0.9, 0.9, 0.9)
    const mat = new THREE.MeshStandardMaterial({ color: 0x16a34a, emissive: 0x4ade80, emissiveIntensity: 1.2, roughness: 0.4 })
    for (let i = 0; i < 5; i++) {
      const mesh = new THREE.Mesh(geom, mat)
      const p = roadPoint(Math.random)
      mesh.position.set(p.x, 1.1, p.z)
      this.scene.add(mesh)
      this.crates.push({ mesh, active: true, respawn: 0 })
    }
  }

  private updateCrates(dt: number): void {
    for (const c of this.crates) {
      if (!c.active) {
        c.respawn -= dt
        if (c.respawn <= 0) {
          const p = roadPoint(Math.random, this.pos, 40)
          c.mesh.position.set(p.x, 1.1, p.z)
          c.mesh.visible = true
          c.active = true
        }
        continue
      }
      c.mesh.rotation.y += dt * 1.6
      c.mesh.position.y = 1.1 + Math.sin(this.time * 2.5 + c.mesh.position.x) * 0.2
      if (c.mesh.position.distanceToSquared(this.pos) < 10) {
        c.active = false
        c.respawn = 45
        c.mesh.visible = false
        this.addChain(60, 'Supply crate')
        this.synth.pickup()
        this.hooks.commit()
      }
    }
  }

  // =============== STREET PICKUPS (v2) ===============
  // Three drive-through boosts scattered on the road grid: nitro cans (cyan),
  // field-repair kits (green cross) and lucky coins (gold). Emissive-only glow
  // plus a flat halo ring — no extra THREE lights, so phones pay almost
  // nothing. They float and spin like the crates and read instantly at speed.
  private spawnPickups(): void {
    const halo = (color: number): THREE.Mesh => {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.85, 0.05, 8, 24),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.y = -0.75
      return ring
    }
    const builders: Record<'nitro' | 'repair' | 'cash', () => THREE.Group> = {
      // Nitro can — tall cyan canister with a bright cap
      nitro: () => {
        const g = new THREE.Group()
        const body = new THREE.Mesh(
          new THREE.CylinderGeometry(0.26, 0.26, 0.85, 10),
          new THREE.MeshStandardMaterial({ color: 0x0e7490, emissive: 0x22d3ee, emissiveIntensity: 1.6, roughness: 0.35 })
        )
        const cap = new THREE.Mesh(
          new THREE.CylinderGeometry(0.13, 0.13, 0.2, 8),
          new THREE.MeshStandardMaterial({ color: 0xecfeff, emissive: 0xa5f3fc, emissiveIntensity: 2.2, roughness: 0.3 })
        )
        cap.position.y = 0.52
        g.add(body, cap, halo(0x22d3ee))
        return g
      },
      // Field-repair kit — white box with a glowing green cross
      repair: () => {
        const g = new THREE.Group()
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(0.7, 0.55, 0.7),
          new THREE.MeshStandardMaterial({ color: 0xf1f5f9, emissive: 0x94a3b8, emissiveIntensity: 0.25, roughness: 0.5 })
        )
        const crossMat = new THREE.MeshStandardMaterial({ color: 0x16a34a, emissive: 0x4ade80, emissiveIntensity: 1.8, roughness: 0.4 })
        const barV = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, 0.06), crossMat)
        barV.position.set(0, 0, 0.36)
        const barH = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.06), crossMat)
        barH.position.set(0, 0, 0.36)
        g.add(box, barV, barH, halo(0x4ade80))
        return g
      },
      // Lucky coin — fat gold disc on edge, spins like a classic coin pickup
      cash: () => {
        const g = new THREE.Group()
        const coin = new THREE.Mesh(
          new THREE.CylinderGeometry(0.42, 0.42, 0.09, 20),
          new THREE.MeshStandardMaterial({ color: 0xb45309, emissive: 0xfbbf24, emissiveIntensity: 1.4, roughness: 0.25, metalness: 0.7 })
        )
        coin.rotation.x = Math.PI / 2
        g.add(coin, halo(0xfbbf24))
        return g
      },
    }
    const put = (kind: 'nitro' | 'repair' | 'cash', count: number): void => {
      for (let i = 0; i < count; i++) {
        const mesh = builders[kind]()
        const p = roadPoint(Math.random)
        mesh.position.set(p.x, 1.1, p.z)
        this.scene.add(mesh)
        this.pickups.push({ kind, mesh, active: true, respawn: 0 })
      }
    }
    put('nitro', 3)
    put('repair', 2)
    put('cash', 3)
  }

  private updatePickups(dt: number): void {
    for (const p of this.pickups) {
      if (!p.active) {
        p.respawn -= dt
        if (p.respawn <= 0) {
          const pt = roadPoint(Math.random, this.pos, 40)
          p.mesh.position.set(pt.x, 1.1, pt.z)
          p.mesh.visible = true
          p.active = true
        }
        continue
      }
      p.mesh.rotation.y += dt * 2.1
      p.mesh.position.y = 1.1 + Math.sin(this.time * 3 + p.mesh.position.z) * 0.18
      if (p.mesh.position.distanceToSquared(this.pos) < 10) {
        p.active = false
        p.respawn = 40 + Math.random() * 15
        p.mesh.visible = false
        if (p.kind === 'nitro') {
          this.boost = Math.min(100, this.boost + 35)
          this.hooks.onToast('⚡ NITRO CAN — boost +35%', 'good')
        } else if (p.kind === 'repair') {
          const before = this.damage
          this.damage = Math.max(0, this.damage - 20)
          this.hooks.onToast(before > 0 ? '🔧 FIELD KIT — damage −20%' : '🔧 Field kit — already pristine', 'good')
        } else {
          this.addChain(35, 'Lucky coin')
        }
        this.synth.pickup()
        this.hooks.commit()
      }
    }
  }

  // =============== LANDMARKS ===============
  private buildLandmarks(): void {
    const mk = (name: string, x: number, z: number, mesh: THREE.Group): void => {
      mesh.position.set(x, 0, z)
      this.scene.add(mesh)
      this.landmarks.push({ name, pos: new THREE.Vector3(x, 0, z), found: false, mesh })
      this.buildings.push({ minX: x - 2.5, maxX: x + 2.5, minZ: z - 2.5, maxZ: z + 2.5 })
    }
    // Crimson Gate — Neon Market (east)
    {
      const g = new THREE.Group()
      const red = new THREE.MeshStandardMaterial({ color: 0xb91c1c, emissive: 0xff3344, emissiveIntensity: 0.5, roughness: 0.6 })
      const p1 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 9, 0.8), red); p1.position.set(-4, 4.5, 0)
      const p2 = p1.clone(); p2.position.x = 4
      const top1 = new THREE.Mesh(new THREE.BoxGeometry(11, 0.9, 1.2), red); top1.position.y = 9.4
      const top2 = new THREE.Mesh(new THREE.BoxGeometry(9, 0.6, 1), red); top2.position.y = 7.6
      g.add(p1, p2, top1, top2)
      mk('Crimson Gate', 150, -80, g)
    }
    // Harbor Light — south dock corner
    {
      const g = new THREE.Group()
      const s1 = new THREE.MeshStandardMaterial({ color: 0xd8dee9, roughness: 0.6 })
      const s2 = new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.6 })
      const t1 = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.0, 6, 12), s1); t1.position.y = 3
      const t2 = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.6, 6, 12), s2); t2.position.y = 9
      const t3 = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 6, 12), s1); t3.position.y = 15
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.3, 12, 10), new THREE.MeshBasicMaterial({ color: 0xfff2b0 }))
      lamp.position.y = 19
      g.add(t1, t2, t3, lamp)
      mk('Harbor Light', -150, 165, g)
    }
    // The Watcher — old town (west)
    {
      const g = new THREE.Group()
      const dark = new THREE.MeshStandardMaterial({ color: 0x11151f, roughness: 0.9 })
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 6, 1.6), dark); body.position.y = 6
      const head = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), dark); head.position.y = 10
      const eyeMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee })
      const e1 = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.1), eyeMat); e1.position.set(-0.35, 10.1, 0.78)
      const e2 = e1.clone(); e2.position.x = 0.35
      const armL = new THREE.Mesh(new THREE.BoxGeometry(0.6, 4.5, 0.6), dark); armL.position.set(-1.6, 6, 0)
      const armR = armL.clone(); armR.position.x = 1.6
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(4, 1.2, 3), dark); plinth.position.y = 0.6
      g.add(body, head, e1, e2, armL, armR, plinth)
      mk('The Watcher', -165, -60, g)
    }
    // Halo Ring — north plaza (rotating hologram)
    {
      const g = new THREE.Group()
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(6, 0.5, 12, 48),
        new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending })
      )
      ring.position.y = 9
      const base = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3, 1.2, 16), new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7 }))
      base.position.y = 0.6
      g.add(ring, base)
      g.userData.spin = ring
      mk('Halo Ring', 60, -165, g)
    }
    // Prism Fountain — plaza south of center
    {
      const g = new THREE.Group()
      const basin = new THREE.Mesh(new THREE.CylinderGeometry(4, 4.4, 1, 20), new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.7 }))
      basin.position.y = 0.5
      const waterGlow = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 0.15, 20), new THREE.MeshBasicMaterial({ color: 0x38e0ff, transparent: true, opacity: 0.6 }))
      waterGlow.position.y = 1.05
      const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, 3.4, 8), new THREE.MeshBasicMaterial({ color: 0x9ff0ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending }))
      jet.position.y = 2.8
      g.add(basin, waterGlow, jet)
      mk('Prism Fountain', -40, 120, g)
    }
  }

  private updateLandmarks(dt: number): void {
    const save = this.hooks.getSave()
    for (const lm of this.landmarks) {
      const spin = lm.mesh.userData.spin as THREE.Mesh | undefined
      if (spin) spin.rotation.y += dt * 0.6
      if (lm.found || save.landmarks.includes(lm.name)) continue
      if (lm.pos.distanceToSquared(this.pos) < 220) {
        lm.found = true
        save.landmarks.push(lm.name)
        this.hooks.commit()
        this.grantCash(150)
        this.grantXp(80)
        this.synth.missionDone()
        this.hooks.onToast(`🏙 Landmark discovered: ${lm.name}  +$150`, 'good')
      }
    }
  }
}

// =============== MODULE HELPERS ===============
interface Placement {
  x: number
  z: number
  w: number
  h: number
  d: number
  tint: number
  signs: number
  model: string
  rot: number
  dist: District
}

/** Scale factor to fit a model base dimension to a target, guarded against zero-size models. */
function w_safe(target: number, base: number): number {
  return base > 0.001 ? target / base : 1
}

type District = 'downtown' | 'beijing' | 'construction' | 'london'

function districtOf(i: number, j: number): District {
  if (Math.abs(i - GARAGE_I) <= 1 && Math.abs(j - GARAGE_J) <= 1) return 'downtown'
  if (j >= 6) return 'construction'
  if (i >= 6) return 'beijing'
  return 'london'
}

/** Seconds allowed to reach a race gate: ~50 km/h average plus a 6 s cushion, never under 10 s. */
function gateSeconds(from: THREE.Vector3, to: THREE.Vector3, rush: number): number {
  return Math.round(Math.max(10, from.distanceTo(to) / 14 + 6) * rush)
}

function roadPoint(rand: () => number, from?: THREE.Vector3, minDist = 0): THREE.Vector3 {
  for (let tries = 0; tries < 60; tries++) {
    const k = Math.floor(rand() * (N + 1))
    const l = Math.floor(rand() * (N + 1))
    const x = -HALF + ROAD / 2 + k * CELL
    const z = -HALF + ROAD / 2 + l * CELL
    const p = new THREE.Vector3(x, 0, z)
    if (!from || p.distanceTo(from) > minDist) return p
  }
  return new THREE.Vector3(0, 0, 0)
}

/** Canvas texture: weathered facade material with the CITY'S OWN PAINT baked
    in — slate (Harbor), red brick (London), cream (Paris), stone (Beijing),
    ochre (Mumbai), pale panels (Tokyo), dark brick (New York). Pattern +
    grime + accent trim make walls read as a real material, not flat paint.
    Tiles 5×5 per face so the texture is visible at street level. */
function makeAsphaltTexture(kind: string): THREE.Texture {
  // Per-city tarmac: the ground a driver actually stares at. Each city lays
  // its own pavement — London's wet black, Paris cobbles, Beijing light
  // concrete, Mumbai's dusty worn surface, Tokyo's clean asphalt, New York's
  // grey with manholes, Harbor's industrial slabs.
  const cv = document.createElement('canvas')
  cv.width = 256
  cv.height = 256
  const ctx = cv.getContext('2d')
  if (!ctx) return new THREE.CanvasTexture(cv)
  let seed = 23
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const W = 256
  const h = (c: string, a = 1) => {
    const [r, g, b] = c.split(',').map(Number)
    return `rgba(${r},${g},${b},${a})`
  }
  if (kind === 'cobble') {
    // Paris: blue-grey rounded cobbles with mortar grooves
    ctx.fillStyle = '#8b8d96'
    ctx.fillRect(0, 0, W, W)
    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < 16; col++) {
        const shade = 0.82 + rnd() * 0.36
        ctx.fillStyle = h(`${Math.round(120 * shade)},${Math.round(124 * shade)},${Math.round(135 * shade)}`)
        ctx.beginPath()
        ctx.arc(col * 16 + 8, row * 16 + 8, 6.4, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  } else if (kind === 'wet') {
    // London: near-black wet tarmac, oily sheen patches
    ctx.fillStyle = '#17181d'
    ctx.fillRect(0, 0, W, W)
    for (let i = 0; i < 46; i++) {
      const x = rnd() * W, y = rnd() * W, r = 4 + rnd() * 14
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, 'rgba(70,78,95,0.18)')
      g.addColorStop(1, 'rgba(70,78,95,0)')
      ctx.fillStyle = g
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
    }
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = 'rgba(255,255,255,0.05)'
      ctx.fillRect(rnd() * W, rnd() * W, 1, 40)
    }
  } else if (kind === 'concrete') {
    // Beijing: light grey concrete with form seams + hairline cracks
    ctx.fillStyle = '#a9abb3'
    ctx.fillRect(0, 0, W, W)
    for (let x = 32; x < W; x += 64) { ctx.fillStyle = 'rgba(60,64,74,0.5)'; ctx.fillRect(x, 0, 3, W) }
    for (let y = 32; y < W; y += 64) { ctx.fillStyle = 'rgba(60,64,74,0.35)'; ctx.fillRect(0, y, W, 2) }
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = 'rgba(70,74,84,0.4)'
      ctx.fillRect(rnd() * W, rnd() * W, 2, 20 + rnd() * 40)
    }
  } else if (kind === 'dusty') {
    // Mumbai: worn dusty tarmac, brown dust, cracks, faded patches
    ctx.fillStyle = '#4a4238'
    ctx.fillRect(0, 0, W, W)
    for (let i = 0; i < 40; i++) {
      const x = rnd() * W, y = rnd() * W, r = 6 + rnd() * 22
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, 'rgba(150,120,72,0.30)')
      g.addColorStop(1, 'rgba(150,120,72,0)')
      ctx.fillStyle = g
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
    }
    for (let i = 0; i < 20; i++) { ctx.fillStyle = 'rgba(10,10,10,0.5)'; ctx.fillRect(rnd() * W, rnd() * W, 2, 12 + rnd() * 50) }
  } else if (kind === 'clean') {
    // Tokyo: fine dark asphalt, even, faint blue cast
    ctx.fillStyle = '#22242c'
    ctx.fillRect(0, 0, W, W)
    for (let i = 0; i < 500; i++) {
      const v = 30 + rnd() * 24
      ctx.fillStyle = `rgba(${v},${Math.round(v * 1.06)},${Math.round(v * 1.22)},0.6)`
      ctx.fillRect(rnd() * W, rnd() * W, 1.4, 1.4)
    }
  } else if (kind === 'grey') {
    // New York: grey asphalt, manhole rings, utility seams
    ctx.fillStyle = '#565a62'
    ctx.fillRect(0, 0, W, W)
    for (let i = 0; i < 380; i++) {
      const v = 78 + rnd() * 34
      ctx.fillStyle = `rgba(${v},${Math.round(v * 1.02)},${Math.round(v * 1.06)},0.55)`
      ctx.fillRect(rnd() * W, rnd() * W, 1.6, 1.6)
    }
    for (let i = 0; i < 3; i++) {
      const x = 40 + rnd() * 176, y = 40 + rnd() * 176
      ctx.strokeStyle = 'rgba(28,30,36,0.8)'
      ctx.lineWidth = 3
      ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke()
      ctx.fillStyle = 'rgba(28,30,36,0.5)'; ctx.fillRect(x - 10, y - 1.2, 20, 2.4)
    }
  } else {
    // Harbor: industrial concrete slabs with expansion gaps + oil stains
    ctx.fillStyle = '#3a3f4a'
    ctx.fillRect(0, 0, W, W)
    for (let x = 0; x < W; x += 85) { ctx.fillStyle = 'rgba(15,18,24,0.85)'; ctx.fillRect(x, 0, 3, W) }
    for (let y = 0; y < W; y += 85) { ctx.fillStyle = 'rgba(15,18,24,0.65)'; ctx.fillRect(0, y, W, 2) }
    for (let i = 0; i < 26; i++) {
      const x = rnd() * W, y = rnd() * W, r = 5 + rnd() * 16
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, 'rgba(10,12,16,0.55)')
      g.addColorStop(1, 'rgba(10,12,16,0)')
      ctx.fillStyle = g
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
    }
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeFacadeTexture(kind: string, base: number, accent: number): THREE.Texture {
  const cv = document.createElement('canvas')
  cv.width = 256
  cv.height = 256
  const ctx = cv.getContext('2d')
  if (!ctx) return new THREE.CanvasTexture(cv)
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const W = 256
  const hex = (c: number, mult = 1) => {
    const r = Math.min(255, Math.round(((c >> 16) & 255) * mult))
    const g = Math.min(255, Math.round(((c >> 8) & 255) * mult))
    const b = Math.min(255, Math.round((c & 255) * mult))
    return `rgb(${r},${g},${b})`
  }
  // base wash, grime-dark toward the street
  const baseGrad = ctx.createLinearGradient(0, 0, 0, 256)
  baseGrad.addColorStop(0, hex(base, 1.06))
  baseGrad.addColorStop(0.7, hex(base))
  baseGrad.addColorStop(1, hex(base, 0.62))
  ctx.fillStyle = hex(base)
  ctx.fillRect(0, 0, W, W)
  ctx.fillStyle = baseGrad
  ctx.fillRect(0, 0, W, W)
  if (kind === 'brick') {
    // running bond brickwork with mortar shadows, tinted by the city base
    for (let row = 0; row < 16; row++) {
      const y = row * 16
      const off = row % 2 === 0 ? 0 : 8
      ctx.fillStyle = 'rgba(20,14,12,0.5)'
      ctx.fillRect(0, y, W, 2) // mortar line
      for (let bx = -1; bx < W / 16; bx++) {
        const shade = 0.86 + rnd() * 0.3
        ctx.fillStyle = hex(base, shade * (row % 5 === 0 ? 0.9 : 1))
        ctx.fillRect(bx * 16 + off, y + 2, 14, 13)
      }
    }
  } else if (kind === 'stone') {
    // ashlar blocks with bevel shading
    for (let row = 0; row < 6; row++) {
      for (let bx = -1; bx < W / 32; bx++) {
        const shade = 0.84 + rnd() * 0.34
        ctx.fillStyle = hex(base, shade)
        ctx.fillRect(bx * 32 + 2, row * 42 + 2, 28, 38)
        ctx.fillStyle = 'rgba(0,0,0,0.30)'
        ctx.fillRect(bx * 32 + 2, row * 42 + 34, 28, 6) // under-block shadow
      }
    }
  } else if (kind === 'concrete') {
    // vertical pour seams + form lines + stains
    ctx.fillStyle = 'rgba(0,0,0,0.22)'
    for (let x = 16; x < W; x += 32) ctx.fillRect(x, 0, 3, W)
    for (let y = 32; y < W; y += 48) ctx.fillRect(0, y, W, 2)
    for (let i = 0; i < 26; i++) {
      const x = rnd() * W
      const y = rnd() * W
      const r = 6 + rnd() * 18
      const g = ctx.createRadialGradient(x, y, 2, x, y, r)
      g.addColorStop(0, 'rgba(18,24,34,0.25)')
      g.addColorStop(1, 'rgba(18,24,34,0)')
      ctx.fillStyle = g
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
    }
  } else if (kind === 'plaster' || kind === 'stucco') {
    // limewash runs + peeling patches in the city's paint color
    for (let i = 0; i < 22; i++) {
      const x = rnd() * W
      const y = rnd() * W * 0.7
      const w = 12 + rnd() * 34
      const h = 30 + rnd() * 90
      const g = ctx.createLinearGradient(x, y, x, y + h)
      g.addColorStop(0, 'rgba(60,45,34,0.22)')
      g.addColorStop(1, 'rgba(60,45,34,0.05)')
      ctx.fillStyle = g
      ctx.fillRect(x - w / 2, y, w, h)
    }
    for (let i = 0; i < 14; i++) {
      const x = rnd() * W
      const y = rnd() * W
      ctx.fillStyle = 'rgba(40,30,24,0.35)'
      ctx.fillRect(x, y, 2 + rnd() * 5, 14 + rnd() * 40) // water runs
    }
    if (kind === 'stucco') {
      for (let i = 0; i < 8; i++) {
        const x = rnd() * W
        const y = rnd() * W
        const r = 6 + rnd() * 12
        ctx.fillStyle = 'rgba(120,96,74,0.5)'
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill() // peeling patch
      }
      // Mumbai art-deco pastel bands — mint, peach, powder blue, pink on the
      // near-white plaster. Reads as South Mumbai deco, not plain white.
      const pastels = ['rgba(42,157,143,0.55)', 'rgba(231,111,81,0.5)', 'rgba(159,184,224,0.5)', 'rgba(242,160,184,0.5)']
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = pastels[i % pastels.length]
        ctx.fillRect(0, 44 + i * 52, W, 15)
      }
    }
  } else if (kind === 'panel') {
    // curtain-wall panels with lit seams
    ctx.fillStyle = 'rgba(0,0,0,0.20)'
    for (let x = 0; x < W; x += 32) ctx.fillRect(x, 0, 2, W)
    for (let y = 0; y < W; y += 32) ctx.fillRect(0, y, W, 2)
    for (let i = 0; i < 40; i++) {
      const x = Math.floor(rnd() * 8) * 32 + 4
      const y = Math.floor(rnd() * 8) * 32 + 4
      ctx.fillStyle = 'rgba(210,225,245,0.12)'
      ctx.fillRect(x, y, 24, 24)
    }
  }
  // accent trim — horizontal string courses + vertical pilasters in the
  // city's signature color, the detail that makes facades look designed
  ctx.fillStyle = `rgba(${((accent >> 16) & 255)},${((accent >> 8) & 255)},${(accent & 255)},0.38)`
  for (let y = 34; y < W; y += 58) ctx.fillRect(0, y, W, 4)
  for (let x = 26; x < W; x += 88) ctx.fillRect(x, 0, 5, W)
  // corner AO + top edge + subtle noise
  const ao = ctx.createLinearGradient(0, 0, 0, 256)
  ao.addColorStop(0, 'rgba(0,0,0,0.32)')
  ao.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = ao
  ctx.fillRect(0, 0, W, W)
  for (let i = 0; i < 400; i++) {
    const a = rnd() * 0.05
    ctx.fillStyle = a > 0.03 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.05)'
    ctx.fillRect(rnd() * W, rnd() * W, 1.5, 1.5)
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(5, 5) // 5 tiles across a face — visible at street level
  tex.anisotropy = 8
  return tex
}

/** Canvas texture: neon billboard sign. */
function makeSignTexture(text: string, color: string): THREE.Texture {
  // Drawn at 4x (1024x512) so sign lettering stays crisp up close.
  const cv = document.createElement('canvas')
  cv.width = 1024
  cv.height = 512
  const ctx = cv.getContext('2d')
  if (!ctx) return new THREE.CanvasTexture(cv)
  ctx.scale(4, 4)
  ctx.fillStyle = '#0a0d18'
  ctx.fillRect(0, 0, 256, 128)
  ctx.strokeStyle = color
  ctx.lineWidth = 6
  ctx.strokeRect(8, 8, 240, 112)
  ctx.font = 'bold 34px "Arial Black", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = color
  ctx.shadowBlur = 18
  ctx.fillStyle = color
  ctx.fillText(text, 128, 64)
  ctx.shadowBlur = 6
  ctx.fillStyle = '#ffffff'
  ctx.globalAlpha = 0.85
  ctx.fillText(text, 128, 64)
  const tex = new THREE.CanvasTexture(cv)
  tex.anisotropy = 8
  return tex
}

/** Canvas texture: soft radial glow (for puddles / light pools). */
function makeGlowTexture(): THREE.Texture {
  const cv = document.createElement('canvas')
  cv.width = 64
  cv.height = 64
  const ctx = cv.getContext('2d')
  if (!ctx) return new THREE.CanvasTexture(cv)
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,0.9)')
  grad.addColorStop(0.5, 'rgba(255,255,255,0.25)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(cv)
}
