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
import { getSkin, getTheme, ACHIEVEMENTS, DISTRICTS, districtAt, TOLL_GATES, type District as ContentDistrict } from './content'
import { grantXp, xpForLevel, type SaveData } from './save'
import { Synth } from './audio'
import { cloneCar, cloneCharacter, CITY_BY_KIND, type GameAssets } from './assets'

// ---------- Public types shared with the React UI ----------
export interface HudMission {
  kind: 'delivery' | 'race' | 'taxi' | 'getaway'
  name: string
  timer: number // seconds left; -1 = no countdown (getaway)
  dist: number
  stage: string
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
  /** true when a chaser (drone/cruiser) is close but hasn't grabbed you yet — HUD shows escape advice */
  pursued: boolean
  /** first-time onboarding: current objective, or null when tutorial is finished */
  tutorial: { step: number; total: number; title: string; hint: string } | null
  mission: HudMission | null
  nearGarage: boolean
  /** border toll booth: a locked district the player can pay cash to enter now */
  nearToll: { name: string; price: number } | null
  busted: boolean
  boosting: boolean
  /** car is wedged (gas held but no movement) — HUD offers the reset recovery */
  stuck: boolean
}

export interface EngineHooks {
  getSave(): SaveData
  commit(): void
  onHud(h: HudState): void
  onToast(msg: string, kind: 'info' | 'cash' | 'warn' | 'good'): void
  onBusted(): void
  onLevelUp(level: number): void
  onMissionDone(name: string, reward: number): void
  onPressE(): void
  onPauseToggle?(): void
  onPhotoToggle?(): void
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

const MAX_SPEED = 36 // m/s (~130 km/h)
const BOOST_MULT = 1.45
const ACCEL = 24
const BRAKE = 34
const CAR_R = 1.6

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
  midnight: 0x060a16,
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
}

type Mission =
  | { kind: 'delivery'; stage: 'pickup' | 'deliver'; a: THREE.Vector3; b: THREE.Vector3; timer: number; name: string }
  | { kind: 'race'; cps: THREE.Vector3[]; idx: number; timer: number; total: number; name: string }
  | { kind: 'taxi'; stage: 'pickup' | 'ride'; a: THREE.Vector3; b: THREE.Vector3; timer: number; name: string; passenger: THREE.Group | null; dist: number }
  | { kind: 'getaway'; heat0: number; name: string }

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
  private bodyMat = new THREE.MeshStandardMaterial({ color: 0x8a93a6, metalness: 0.7, roughness: 0.35 })
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
  private assets: GameAssets
  private drones: Drone[] = []
  private shards: Shard[] = []
  private ramps: Ramp[] = []
  private traffic: TrafficCar[] = []
  private blinkMat = new THREE.MeshBasicMaterial({ color: 0xff2233 })
  private garagePos = new THREE.Vector3()
  private markerBeacon: THREE.Mesh
  private rain: THREE.Points | null = null
  private rainVel: Float32Array | null = null
  private waterTex: THREE.Texture | null = null
  private ambient: THREE.HemisphereLight
  private moon: THREE.DirectionalLight
  private groundMat!: THREE.MeshStandardMaterial

  // Game state
  private heat = 0
  private lastHeatInt = 0
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
    dog?: THREE.Group
  }[] = []
  private crates: { mesh: THREE.Mesh; active: boolean; respawn: number }[] = []
  private landmarks: { name: string; pos: THREE.Vector3; found: boolean; mesh: THREE.Group }[] = []
  private cruisers: { mesh: THREE.Group; barL: THREE.Mesh; barR: THREE.Mesh; pos: THREE.Vector3; vel: THREE.Vector3; wp: THREE.Vector3; heading: number; bob: number }[] = []
  private smoke: { sprite: THREE.Sprite; life: number; max: number }[] = []

  // Street cred chain multiplier
  private chainCount = 0
  private chainTimer = 0

  constructor(canvas: HTMLCanvasElement, minimap: HTMLCanvasElement, hooks: EngineHooks, assets: GameAssets) {
    this.mmCanvas = minimap
    this.hooks = hooks
    this.assets = assets
    this.canvas = canvas

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.15
    // Real-time shadows — the single biggest realism lift in the whole render
    this.renderer.shadowMap.enabled = true
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1600)
    this.camera.position.set(0, 5, 30)

    // Post-processing: neon bloom
    this.composer = new EffectComposer(renderer)
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
    this.moon.shadow.mapSize.set(2048, 2048)
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
    this.headL = new THREE.SpotLight(0xcfe8ff, 60, 60, 0.5, 0.4, 1.6)
    this.headR = new THREE.SpotLight(0xcfe8ff, 60, 60, 0.5, 0.4, 1.6)
    this.scene.add(this.headL, this.headL.target, this.headR, this.headR.target)
    // The one real beam: shadow-casting, lights the tarmac ahead of the car
    this.headSpot = new THREE.SpotLight(0xfff3d6, 85, 48, 0.36, 0.55, 1.35)
    this.headSpot.castShadow = true
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

    this.buildCity()
    this.buildCar()
    this.spawnShards()
    this.spawnDrones()
    this.spawnTraffic()
    this.spawnPedestrians()
    this.spawnCrates()
    this.buildLandmarks()
    this.spawnCruisers()
    this.initSmoke()
    this.applyLoadout()
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
            if (rand() < (dist === 'docks' ? 0.35 : 0.16)) continue // empty lot
            const lotW = BLOCK / 2
            const w = lotW - 3 - rand() * 3
            const d = lotW - 3 - rand() * 3
            const tall = dist === 'downtown'
            const flat = dist === 'docks'
            const podium = !flat && rand() < (tall ? 0.55 : 0.3)
            const hBase = flat ? 7 + rand() * 9 : tall ? 26 + rand() * 34 : 12 + rand() * 16
            const h = podium ? Math.min(hBase, 15) : hBase
            const x = bx + li * lotW + lotW / 2 + (rand() - 0.5) * 2
            const z = bz + lj * lotW + lotW / 2 + (rand() - 0.5) * 2
            const signs = dist === 'market' ? 4 : dist === 'downtown' ? 2 : 1
            const baseKind: 'skyscraper' | 'midrise' | 'lowrise' = flat ? 'lowrise' : tall && !podium ? 'skyscraper' : 'midrise'
            const place = (p: Placement) => {
              placements.push(p)
              if (dist === 'market') marketPlacements.push(p)
              this.buildings.push({ minX: p.x - p.w / 2, maxX: p.x + p.w / 2, minZ: p.z - p.d / 2, maxZ: p.z + p.d / 2 })
            }
            place({ x, z, w, h, d, tint: 0.75 + rand() * 0.5, signs, model: pickModel(baseKind, rand), rot: Math.floor(rand() * 4), dist })
            // Tower on podium — skyline variety
            if (podium && rand() < (tall ? 0.85 : 0.4)) {
              const th = h + 12 + rand() * (tall ? 30 : 12)
              place({
                x: x + (rand() - 0.5) * 2, z: z + (rand() - 0.5) * 2,
                w: w * 0.55, h: th, d: d * 0.55, tint: 0.9 + rand() * 0.4,
                signs: dist === 'market' ? 2 : 1,
                model: pickModel(tall ? 'skyscraper' : 'midrise', rand), rot: Math.floor(rand() * 4),
                dist,
              })
            }
          }
        }
      }
    }
    // One InstancedMesh per building model; district mood via instance tint
    const byModel = new Map<string, Placement[]>()
    for (const p of placements) {
      const list = byModel.get(p.model) ?? []
      list.push(p)
      byModel.set(p.model, list)
    }
    const col = new THREE.Color()
    const pos = new THREE.Vector3()
    const scl = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const yAxis = new THREE.Vector3(0, 1, 0)
    for (const [model, list] of byModel) {
      const cm = this.assets.city[model]
      if (!cm) continue
      const inst = new THREE.InstancedMesh(cm.geometry, this.assets.cityMaterial, list.length)
      inst.castShadow = true
      inst.receiveShadow = true
      list.forEach((p, idx) => {
        const rot90 = p.rot % 2 === 1
        const bw = rot90 ? cm.size.z : cm.size.x
        const bd = rot90 ? cm.size.x : cm.size.z
        scl.set(w_safe(p.w, bw), p.h / cm.size.y, w_safe(p.d, bd))
        quat.setFromAxisAngle(yAxis, p.rot * Math.PI * 0.5)
        pos.set(p.x, -cm.minY * scl.y, p.z)
        m4.compose(pos, quat, scl)
        inst.setMatrixAt(idx, m4)
        // District tint: cool blue downtown, neon-pink market, warm oldtown, grey docks
        if (p.dist === 'downtown') col.setRGB(0.72 * p.tint, 0.82 * p.tint, 1.05 * p.tint)
        else if (p.dist === 'market') col.setRGB(1.05 * p.tint, 0.78 * p.tint, 0.95 * p.tint)
        else if (p.dist === 'oldtown') col.setRGB(1.05 * p.tint, 0.92 * p.tint, 0.72 * p.tint)
        else col.setRGB(0.82 * p.tint, 0.88 * p.tint, 0.95 * p.tint)
        inst.setColorAt(idx, col)
      })
      inst.instanceMatrix.needsUpdate = true
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true
      this.scene.add(inst)
    }

    // Parapet caps on every roofline (finished architecture silhouette)
    const capGeom = new THREE.BoxGeometry(1, 1, 1)
    const capMat = new THREE.MeshStandardMaterial({ color: 0x11141f, roughness: 0.9 })
    const caps = new THREE.InstancedMesh(capGeom, capMat, Math.max(placements.length, 1))
    placements.forEach((p, idx) => {
      m4.makeScale(p.w + 0.5, 0.55, p.d + 0.5)
      m4.setPosition(p.x, p.h + 0.1, p.z)
      caps.setMatrixAt(idx, m4)
    })
    caps.instanceMatrix.needsUpdate = true
    this.scene.add(caps)

    // Lit window grids on facades — the night city glows floor by floor instead of
    // reading as flat silhouettes. ONE instanced draw call for every pane in the
    // city; per-instance color picks lit (warm/cool) vs dark glass, and the shared
    // material is dimmed to glass-blue by day via the theme hook.
    const winRand = seededRand(3141)
    const winTransforms: { x: number; y: number; z: number; ry: number }[] = []
    for (const p of placements) {
      if (p.h < 9) continue
      const rows = Math.min(14, Math.floor((p.h - 3) / 2.6))
      if (rows < 2) continue
      const rot = p.rot * Math.PI * 0.5
      const cosR = Math.cos(rot)
      const sinR = Math.sin(rot)
      const colsF = Math.max(2, Math.floor((p.w - 2) / 2.1))
      for (const side of [-1, 1] as const) {
        for (let r = 0; r < rows; r++) {
          for (let cI = 0; cI < colsF; cI++) {
            if (winRand() < 0.18) continue // unwindowed bays break up the grid
            const lx = colsF > 1 ? -p.w / 2 + 1.2 + (cI * (p.w - 2.4)) / (colsF - 1) : 0
            const ly = 2.2 + r * 2.6
            const lz = side * (p.d / 2 + 0.06)
            winTransforms.push({
              x: p.x + lx * cosR + lz * sinR,
              y: ly,
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
    const winWarm = new THREE.Color(0xffd9a0)
    const winCool = new THREE.Color(0xbfe0ff)
    const winDark = new THREE.Color(0x141a26)
    winTransforms.forEach((wI, idx) => {
      quat.setFromAxisAngle(yAxis, wI.ry)
      m4.compose(new THREE.Vector3(wI.x, wI.y, wI.z), quat, scl.set(1, 1, 1))
      winInst.setMatrixAt(idx, m4)
      const lit = winRand() < 0.42
      if (lit) col.copy(winRand() < 0.75 ? winWarm : winCool).multiplyScalar(0.75 + winRand() * 0.5)
      else col.copy(winDark)
      winInst.setColorAt(idx, col)
    })
    winInst.instanceMatrix.needsUpdate = true
    if (winInst.instanceColor) winInst.instanceColor.needsUpdate = true
    this.scene.userData.winMat = winMat
    this.scene.add(winInst)

    // Neon corner trims — market district towers get glowing vertical edges
    const trimGeom = new THREE.BoxGeometry(1, 1, 1)
    const trimMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    const trimPick = marketPlacements
    const trims = new THREE.InstancedMesh(trimGeom, trimMat, Math.max(trimPick.length * 2, 1))
    const trimRand = seededRand(606)
    const trimPalette = [0xff2d95, 0x22d3ee, 0xc084fc]
    let tri = 0
    trimPick.forEach((p) => {
      for (const sx of [-1, 1]) {
        m4.makeScale(0.28, p.h * (0.55 + trimRand() * 0.4), 0.28)
        m4.setPosition(p.x + sx * (p.w / 2 + 0.05), p.h * 0.5, p.z + (p.d / 2 + 0.05))
        trims.setMatrixAt(tri, m4)
        col.setHex(trimPalette[Math.floor(trimRand() * trimPalette.length)])
        trims.setColorAt(tri, col)
        tri++
      }
    })
    trims.instanceMatrix.needsUpdate = true
    if (trims.instanceColor) trims.instanceColor.needsUpdate = true
    this.scene.add(trims)

    // Rooftop aircraft-warning blinkers
    const blinkGeom = new THREE.SphereGeometry(0.32, 6, 6)
    const blinkPick = placements.filter((p) => p.h > 24).slice(0, 40)
    const blinkInst = new THREE.InstancedMesh(blinkGeom, this.blinkMat, Math.max(blinkPick.length, 1))
    blinkPick.forEach((p, idx) => {
      m4.makeScale(1, 1, 1)
      m4.setPosition(p.x, p.h + 0.5, p.z)
      blinkInst.setMatrixAt(idx, m4)
    })
    blinkInst.instanceMatrix.needsUpdate = true
    this.scene.add(blinkInst)

    // Neon signs (instanced emissive boxes on facades)
    const neonPalette = [0xff2d95, 0x22d3ee, 0xa3e635, 0xf97316, 0xc084fc, 0xfde047]
    const neonGeom = new THREE.BoxGeometry(1, 1, 1)
    const neonMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    const neonRand = seededRand(777)
    const neonCount = placements.reduce((s, p) => s + p.signs, 0)
    const neon = new THREE.InstancedMesh(neonGeom, neonMat, Math.max(neonCount, 1))
    let ni = 0
    placements.forEach((p) => {
      for (let k = 0; k < p.signs; k++) {
        const w = 1.5 + neonRand() * 5
        const h = 0.4 + neonRand() * 1.4
        const y = 3 + neonRand() * Math.max(p.h - 4, 4)
        const side = Math.floor(neonRand() * 4)
        let x = p.x
        let z = p.z
        let sx = w
        let sz = 0.35
        if (side === 0) { z = p.z - p.d / 2 - 0.1 } else if (side === 1) { z = p.z + p.d / 2 + 0.1 } else if (side === 2) { x = p.x - p.w / 2 - 0.1; sx = 0.35; sz = w } else { x = p.x + p.w / 2 + 0.1; sx = 0.35; sz = w }
        m4.makeScale(sx, h, sz)
        m4.setPosition(x, y, z)
        neon.setMatrixAt(ni, m4)
        col.setHex(neonPalette[Math.floor(neonRand() * neonPalette.length)])
        neon.setColorAt(ni, col)
        ni++
      }
    })
    neon.instanceMatrix.needsUpdate = true
    if (neon.instanceColor) neon.instanceColor.needsUpdate = true
    this.scene.add(neon)

    // Storefront glow bands at street level + rooftop props
    const shopGeom = new THREE.BoxGeometry(1, 1, 1)
    const shopMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    const shopPick = placements.filter((p) => p.h <= 32)
    const shopInst = new THREE.InstancedMesh(shopGeom, shopMat, Math.max(shopPick.length, 1))
    const shopPalette = [0xffd9a0, 0x9fd8ff, 0xffb3d9, 0xc8ffd9, 0xfff3b0]
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
    this.scene.add(shopInst)

    const roofPick = placements.filter((p) => p.h > 18)
    const tankGeom = new THREE.CylinderGeometry(1.1, 1.1, 2.4, 10)
    const tankMat = new THREE.MeshStandardMaterial({ color: 0x4a5568, roughness: 0.8 })
    const acGeom = new THREE.BoxGeometry(2, 1.1, 1.4)
    const acMat = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.85 })
    const tanks = new THREE.InstancedMesh(tankGeom, tankMat, Math.max(Math.ceil(roofPick.length / 2), 1))
    const acs = new THREE.InstancedMesh(acGeom, acMat, Math.max(Math.ceil(roofPick.length / 2), 1))
    let ti = 0
    let ai = 0
    roofPick.forEach((p, idx) => {
      if (idx % 2 === 0) {
        m4.makeScale(1, 1, 1)
        m4.setPosition(p.x + p.w * 0.22, p.h + 1.2, p.z - p.d * 0.18)
        tanks.setMatrixAt(ti++, m4)
      } else {
        m4.makeScale(1, 1, 1)
        m4.setPosition(p.x - p.w * 0.2, p.h + 0.55, p.z + p.d * 0.2)
        acs.setMatrixAt(ai++, m4)
      }
    })
    tanks.instanceMatrix.needsUpdate = true
    acs.instanceMatrix.needsUpdate = true
    this.scene.add(tanks, acs)

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
      this.buildings.push({ minX: s.x - 0.25, maxX: s.x + 0.25, minZ: s.z - 0.25, maxZ: s.z + 0.25 })
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
    this.genTollGates()
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
      c.width = 512; c.height = 128
      const g = c.getContext('2d')
      if (!g) return null
      g.fillStyle = '#0a0f1c'
      g.fillRect(0, 0, 512, 128)
      g.font = 'bold 72px monospace'
      g.textAlign = 'center'
      g.shadowColor = '#22d3ee'; g.shadowBlur = 14
      g.fillStyle = '#67e8f9'
      g.fillText('NEON HARBOR', 256, 88)
      return new THREE.CanvasTexture(c)
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

    // Spawn just past the gantry so the neon arch frames the player's starting view instead of filling it
    this.pos.set(gx, 0, gz + 19)
    this.drawMinimapBase()
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
  private idlers: { mesh: THREE.Object3D; mixer: THREE.AnimationMixer }[] = []
  private moonTrackMat: THREE.MeshBasicMaterial | null = null
  private foamNight = 1

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
          this.buildings.push({ minX: g.position.x - 0.3, maxX: g.position.x + 0.3, minZ: g.position.z - 0.3, maxZ: g.position.z + 0.3 })
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

  private updateIdlers(dt: number): void {
    for (const id of this.idlers) {
      id.mixer.update(dt)
      // subtle life: a gentle idle bob so the crowd never looks frozen
      id.mesh.position.y = Math.abs(Math.sin(this.time * 0.9 + id.mesh.position.x * 0.7)) * 0.02
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

  /** Real toll plazas: booth + striped boom barrier across a clean road at
      each gated district's border. The barrier is solid until the district
      unlocks (level or payment), then it rises and stays open. */
  private genTollGates(): void {
    // red/white diagonal stripe texture for the boom pole
    const stripeTex = (() => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 64
      const g = c.getContext('2d')
      if (!g) return null
      g.fillStyle = '#f2f4f8'
      g.fillRect(0, 0, 64, 64)
      g.fillStyle = '#e0332e'
      for (let i = -2; i < 6; i++) {
        g.save()
        g.translate(i * 24, 0)
        g.rotate(Math.PI / 4)
        g.fillRect(0, -32, 12, 128)
        g.restore()
      }
      const t = new THREE.CanvasTexture(c)
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(4, 1)
      return t
    })()
    const poleMat = new THREE.MeshStandardMaterial({ map: stripeTex ?? undefined, color: stripeTex ? 0xffffff : 0xe0332e, roughness: 0.5 })
    const boothMat = new THREE.MeshStandardMaterial({ color: 0x1d2b45, roughness: 0.6 })
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xe0332e, roughness: 0.55 })
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 })
    const signTex = (() => {
      const c = document.createElement('canvas')
      c.width = 256
      c.height = 80
      const g = c.getContext('2d')
      if (!g) return null
      g.fillStyle = '#0b1220'
      g.fillRect(0, 0, 256, 80)
      g.font = 'bold 46px Arial'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.shadowColor = '#67e8f9'
      g.shadowBlur = 12
      g.fillStyle = '#a5f3fc'
      g.fillText('T O L L', 128, 42)
      return new THREE.CanvasTexture(c)
    })()

    for (const tg of TOLL_GATES) {
      const district = DISTRICTS.find((d) => d.id === tg.district)
      if (!district) continue
      const g = new THREE.Group()
      // booth on the sidewalk beside the road edge
      const bx = tg.span === 'x' ? tg.x - 9.4 : tg.x
      const bz = tg.span === 'x' ? tg.z : tg.z - 9.4
      const booth = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.5, 2.1), boothMat)
      booth.position.set(bx, 1.25, bz)
      booth.castShadow = true
      const roof = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.28, 2.5), roofMat)
      roof.position.set(bx, 2.65, bz)
      const win = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.9), glowMat)
      win.position.set(bx + (tg.span === 'x' ? 1.16 : 0), 1.5, bz + (tg.span === 'x' ? 0 : 1.06))
      if (tg.span === 'x') win.rotation.y = Math.PI / 2
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(2.2, 0.68),
        new THREE.MeshBasicMaterial({ map: signTex ?? undefined, color: signTex ? 0xffffff : 0xa5f3fc })
      )
      sign.position.set(bx, 3.15, bz + (tg.span === 'x' ? 0 : 1.28))
      if (tg.span === 'x') {
        sign.position.x = bx + 1.3
        sign.rotation.y = Math.PI / 2
      }
      // boom pole on a pivot at the booth-side end of the road
      const pivot = new THREE.Group()
      pivot.position.set(tg.span === 'x' ? tg.x - 7.1 : tg.x, 1.05, tg.span === 'x' ? tg.z : tg.z - 7.1)
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 13.6, 10), poleMat)
      pole.rotation.z = tg.span === 'x' ? Math.PI / 2 : 0
      pole.rotation.x = tg.span === 'z' ? Math.PI / 2 : 0
      if (tg.span === 'x') pole.position.x = 6.8
      else pole.position.z = 6.8
      pole.castShadow = true
      // pole support post
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 1.15, 10), roofMat)
      post.position.y = -0.5
      pivot.add(post, pole)
      g.add(booth, roof, win, sign, pivot)
      this.scene.add(g)
      // booth is always solid; pole segments are solid only while closed
      this.buildings.push({ minX: bx - 1.2, maxX: bx + 1.2, minZ: bz - 1.1, maxZ: bz + 1.1 })
      const colliders: AABB[] = []
      for (let i = 0; i < 5; i++) {
        const along = (tg.span === 'x' ? pivot.position.x : pivot.position.z) + 1.36 + i * 2.72
        const c: AABB = tg.span === 'x'
          ? { minX: along - 1.4, maxX: along + 1.4, minZ: tg.z - 0.45, maxZ: tg.z + 0.45 }
          : { minX: tg.x - 0.45, maxX: tg.x + 0.45, minZ: along - 1.4, maxZ: along + 1.4 }
        colliders.push(c)
        this.buildings.push(c)
      }
      this.tollGates.push({ district: tg.district, span: tg.span, pivot, colliders, open: false, anim: 0 })
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
    const poolMat = new THREE.MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false })
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
    const rand = seededRand(31415)
    const palettes: Record<string, number[]> = {
      // saturated "neon city" palette — dark greys vanish under the night sky
      sedan: [0x4f7fb8, 0xb85c7a, 0x5aa88f, 0xc9cdd6, 0x7a6fc9],
      hatch: [0xe23b3b, 0x2f9fd8, 0xf0a020, 0x4fbf67, 0xa06fd8],
      van: [0xb8c0cc, 0x6fa35f, 0x4f8fb8, 0x98a5b5],
      sport: [0xfacc15, 0x22d3ee, 0xff4d6d, 0xf2f6ff],
    }
    const styles = ['sedan', 'sedan', 'hatch', 'hatch', 'van', 'taxi', 'sport', 'sedan', 'hatch', 'van', 'sedan', 'sport', 'sedan', 'hatch', 'van', 'sedan', 'taxi', 'hatch', 'sport', 'sedan']
    for (let k = 0; k < styles.length; k++) {
      const style = styles[k]
      const palette = style === 'taxi' ? [0xf59e0b] : palettes[style] ?? palettes.sedan
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
      this.scene.add(g)
      this.traffic.push({ mesh: g, axis, lane, dir, speed: 0, cruise: 8 + rand() * 4, nmCooldown: 0 })
    }
  }

  private makeTrafficCar(style: string, color: number): THREE.Group {
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
  private pendingRain = false
  private targetTheme: ReturnType<typeof getTheme> | null = null
  private themeSkyCanvas: HTMLCanvasElement | null = null
  private themeSkyTex: THREE.CanvasTexture | null = null

  private applyTheme(t: ReturnType<typeof getTheme>): void {
    const to = this.themeMixOf(t)
    if (!this.themeTo) {
      // First apply after load: snap straight to the theme.
      this.themeFrom = to
      this.themeTo = to
      this.themeBlend = 1
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
    this.pendingRain = t.rain
    this.targetTheme = t
    if (t.rain && !this.rain) this.setupRain()
  }

  private updateTheme(dt: number): void {
    if (this.themeBlend >= 1 || !this.themeFrom || !this.themeTo) return
    this.themeBlend = Math.min(1, this.themeBlend + dt / 9)
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
      cityEm: day ? 0.1 : 0.38,
      skyEm: day ? 0.12 : 0.55,
      headSpot: day ? 0 : 260,
      winColor: day ? 0x46566e : 0xffffff,
      lens: day ? 0x9aa6ad : 0xffe2b0,
      pool: day ? 0 : 0.15,
      glow: day ? 0 : 0.35,
      track: day ? 0 : t.id === 'golden' ? 0.5 : 0.38,
      foamNight: day ? 1 : 1.9,
      cloudColor: dayGolden ? 0xffffff : t.id === 'sakura' ? 0x5a4a6e : 0x1a2333,
      cloudOpacity: dayGolden ? 0.95 : t.id === 'sakura' ? 0.7 : 0.42,
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
  resetToRoad(): void {
    const kx = THREE.MathUtils.clamp(Math.round((this.pos.x + HALF - ROAD / 2) / CELL), 0, N)
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
      else if (this.nearLocked) this.payToll()
    }
    if (k === ' ' && this.bustedMeter > 0.25 && this.mashCooldown <= 0 && !this.busted && !this.paused && !this.attract) {
      // Struggle free from the patrol grab
      this.bustedMeter = Math.max(0, this.bustedMeter - 0.7)
      this.mashCooldown = 0.16
      this.vel.multiplyScalar(1.05)
      this.synth.checkpoint()
    }
    if (k === 'c' && !this.attract) this.camDist = this.camDist > 12 ? 10 : 17
    if (k === 'r' && !this.attract && !this.paused) {
      this.resetToRoad()
      this.synth.checkpoint()
    }
    if (k === 'p' && !this.attract && !this.paused) this.hooks.onPhotoToggle?.()
    if (k === 'h') this.synth.horn()
    if (k === 't' && !this.attract && !this.paused) {
      const s = this.hooks.getSave()
      if (!s.tutorialDone) {
        s.tutorialDone = true
        this.hooks.commit()
        this.hooks.onToast('Tutorial skipped — the whole city is open. ESC opens the menu.', 'info')
      }
    }
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
  /** CoD-style swipe steer: each horizontal pixel the finger travels adds
      steering input, which then bleeds off in the update loop. A fast flick
      = sharp turn, a slow drag = gentle arc, holding the finger still =
      straight. Pass null on release to clear immediately. */
  touchSwipeDelta(dx: number): void {
    this.swipeSteer = THREE.MathUtils.clamp((this.swipeSteer ?? 0) + dx * 0.022, -1, 1)
  }
  touchSwipeSteer(v: number | null): void {
    this.swipeSteer = v
  }
  /** One-shot action buttons reuse the keyboard handler (E / mash SPACE / C / H / T) */
  touchTap(k: string): void { this.onKeyDown(new KeyboardEvent('keydown', { key: k })) }

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
  private loop = (): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    this.timer.update()
    const dt = Math.min(this.timer.getDelta(), 0.05)
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
    const pr = this.qualityLevel === 0 ? Math.min(dpr, 1.75) : this.qualityLevel === 1 ? Math.min(dpr, 1.25) : 1
    this.renderer.setPixelRatio(pr)
    this.composer.setPixelRatio(pr)
    this.resize()
    if (this.qualityLevel >= 2) {
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
    this.updateCar(dt)
    this.updateTraffic(dt)
    this.updateCruisers(dt)
    this.updateSmoke(dt)
    this.updatePedestrians(dt)
    this.updateBirds(dt)
    this.updateWaves()
    this.updateHarborLife(dt)
    this.updateTrafficLights()
    this.updateTheme(dt)
    this.updateIdlers(dt)
    this.updateCrates(dt)
    this.updateLandmarks(dt)
    this.updateDistricts(dt)
    this.updateDronesAndHeat(dt)
    // street cred chain decay
    if (this.chainTimer > 0) {
      this.chainTimer -= dt
      if (this.chainTimer <= 0) this.chainCount = 0
    }
    this.updateMission(dt)
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
    if (edge(1) && !this.attract) this.camDist = this.camDist > 12 ? 10 : 17 // B: camera
    if (edge(2)) this.synth.horn() // X
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

    const dir = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))
    let s = this.vel.dot(dir)

    this.boosting = false
    if (this.bustedCooldown > 0) {
      this.bustedCooldown -= dt
      if (this.bustedCooldown <= 0) this.busted = false
    }
    const frozen = this.busted || this.attract

    if (!frozen && wantBoost && this.boost > 0 && s > 4) {
      this.boosting = true
      this.boost = Math.max(0, this.boost - 32 * dt)
    } else {
      this.boost = Math.min(100, this.boost + 11 * dt)
    }

    if (!frozen) {
      const mult = this.boosting ? BOOST_MULT : 1
      // Joystick / gamepad (analog) input replaces the digital pedals when active
      const aThr = effThr
      const gas = aThr !== null ? aThr > 0.12 : up
      const braking = aThr !== null ? aThr < -0.12 : down
      if (gas) s += ACCEL * (aThr !== null ? Math.min(1, aThr) : 1) * mult * dt
      if (braking) s -= (s > 1 ? BRAKE : ACCEL * 0.6) * dt
      const maxS = MAX_SPEED * mult
      s = THREE.MathUtils.clamp(s, -10, maxS)
      // Swipe steering is motion-based (CoD-style): finger movement adds steer
      // input which bleeds off fast — a held-still finger goes straight.
      if (this.swipeSteer !== null) {
        this.swipeSteer *= Math.exp(-dt * 6)
        if (Math.abs(this.swipeSteer) < 0.03) this.swipeSteer = null
      }
      // Joystick tilt keeps only partial steering authority — the right-thumb
      // swipe is the primary steering, like aiming in CoD Mobile.
      const joySteer = this.analogSteer !== null ? this.analogSteer * 0.55 : null
      const aSt = this.padSteer ?? this.swipeSteer ?? joySteer
      const steer = aSt !== null ? -aSt : (left ? 1 : 0) - (right ? 1 : 0)
      const grip = handbrake ? 1.4 : 7.5
      const turnRate = steer * 2.1 * THREE.MathUtils.clamp(Math.abs(s) / 10, 0, 1) * (handbrake ? 1.5 : 1)
      this.heading += turnRate * dt * Math.sign(s >= 0 ? 1 : -1)
      const newDir = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))
      const lat = this.vel.clone().sub(newDir.clone().multiplyScalar(this.vel.dot(newDir)))
      lat.multiplyScalar(Math.exp(-dt * grip))
      this.vel.copy(newDir.multiplyScalar(s)).add(lat)
      const onRoad = this.isOnRoad(this.pos.x, this.pos.z)
      const drag = onRoad ? 0.45 : 2.6
      this.vel.multiplyScalar(Math.exp(-dt * drag))
      // Stuck detection: flooring the gas but barely moving (wedged on a pole,
      // barrier or wall). HUD then offers the R-key / RESET-button recovery.
      // The prompt LATCHES for a few seconds after the player lets go — a wedged
      // player who stops pressing still sees the way out instead of a dead car.
      if (gas && this.vel.lengthSq() < 4) {
        this.stuckTime += dt
        if (this.stuckTime > 2) this.stuckLatch = 6
      } else {
        this.stuckTime = 0
        this.stuckLatch = Math.max(0, this.stuckLatch - dt)
      }
      // Driving freely again clears the latch immediately.
      if (this.vel.lengthSq() > 25) this.stuckLatch = 0
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

    // Gravity / jumps
    if (this.grounded) {
      for (const r of this.ramps) {
        const dx = this.pos.x - r.x
        const dz = this.pos.z - r.z
        const sp = this.vel.length()
        if (dx * dx + dz * dz < 9 && sp > 13) {
          this.vy = sp * 0.42
          this.grounded = false
          this.airTime = 0
          this.synth.jump()
        }
      }
    }
    if (!this.grounded) {
      this.vy -= 32 * dt
      this.pos.y += this.vy * dt
      this.airTime += dt
      if (this.pos.y <= 0) {
        this.pos.y = 0
        this.grounded = true
        if (this.airTime > 0.55) {
          this.addChain(this.airTime * 90, 'Airtime')
        }
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
        this.grantXp(30)
        this.synth.pickup()
        this.hooks.commit()
        if (save.shards.length >= 12) this.unlockAchievement('shard-12')
        if (save.shards.length >= 24) this.unlockAchievement('shard-24')
      }
    }

    this.nearGarage = this.pos.distanceTo(this.garagePos) < 11

    // Apply to meshes
    this.car.position.copy(this.pos)
    this.car.rotation.y = this.heading
    const spin = s * dt / 0.38
    for (const w of this.wheels) w.rotation.x += spin
    this.shake = Math.max(0, this.shake - dt * 1.8)
  }

  private isOnRoad(x: number, z: number): boolean {
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
        this.vel.x -= nx * vDot * 1.85
        this.vel.z -= nz * vDot * 1.85
        // Grazes still register: tiny jolt so clipping a pole never feels free
        if (impact > 1.5) this.shake = Math.min(this.shake + impact * 0.02, 0.85)
        if (impact > 2.5) {
          this.shake = Math.min(this.shake + impact * 0.05, 0.85)
          this.synth.thud()
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
        if (impact > 12) this.heat = Math.min(5, this.heat + 0.35)
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
    if (this.pos.z > L) { this.pos.z = L; this.vel.z = -Math.abs(this.vel.z) * 0.4 }
  }

  private grantCash(amount: number): void {
    const save = this.hooks.getSave()
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
  // A border toll booth lets anyone pay cash to enter a locked district early.
  private districtCd = 0
  private nearLocked: { d: ContentDistrict; price: number } | null = null
  private tollGates: Array<{ district: string; span: 'x' | 'z'; pivot: THREE.Group; colliders: AABB[]; open: boolean; anim: number }> = []
  private updateDistricts(dt: number): void {
    this.districtCd = Math.max(0, this.districtCd - dt)
    const save = this.hooks.getSave()
    const tolled = (id: string) => save.tollsPaid.includes(id)
    const lockedDist = (id: string) => {
      const d = DISTRICTS.find((x) => x.id === id)
      return d && save.level < d.minLevel && !tolled(d.id) ? d : null
    }
    // Toll gates: barriers rise once the district is unlocked (level or paid)
    for (const gate of this.tollGates) {
      const dist = DISTRICTS.find((x) => x.id === gate.district)
      if (!dist) continue
      const open = save.level >= dist.minLevel || tolled(dist.id)
      if (open && !gate.open) {
        gate.open = true
        this.buildings = this.buildings.filter((b) => !gate.colliders.includes(b))
        this.hooks.onToast(`🎫 The toll gate to ${dist.name} is open — drive through!`, 'good')
        this.synth.buy()
      }
      const target = open ? 1 : 0
      gate.anim += (target - gate.anim) * Math.min(dt * 2.5, 1)
      if (gate.span === 'x') gate.pivot.rotation.z = -gate.anim * 1.35
      else gate.pivot.rotation.x = gate.anim * 1.35
    }
    this.nearLocked = null
    const d = districtAt(this.pos.x, this.pos.z)
    // toll booth proximity: near a locked district's toll gate
    for (const gate of this.tollGates) {
      const dist = lockedDist(gate.district)
      if (!dist) continue
      const dx = gate.pivot.position.x - this.pos.x
      const dz = gate.pivot.position.z - this.pos.z
      if (dx * dx + dz * dz < 144) {
        this.nearLocked = { d: dist, price: dist.minLevel * 250 }
        break
      }
    }
    if (d && save.level < d.minLevel && !tolled(d.id)) {
      // inside a locked district — find the nearest border and clamp to it
      const pens = [
        { p: this.pos.x - d.minX, axis: 'x' as const, low: true },
        { p: d.maxX - this.pos.x, axis: 'x' as const, low: false },
        { p: this.pos.z - d.minZ, axis: 'z' as const, low: true },
        { p: d.maxZ - this.pos.z, axis: 'z' as const, low: false },
      ].sort((a, b) => a.p - b.p)[0]
      const clear = CAR_R + 0.6
      if (pens.axis === 'x') this.pos.x = pens.low ? d.minX - clear : d.maxX + clear
      else this.pos.z = pens.low ? d.minZ - clear : d.maxZ + clear
      // remove only the inward velocity — sliding along the wall stays possible
      if (pens.axis === 'x') this.vel.x = pens.low ? Math.min(this.vel.x, 0) : Math.max(this.vel.x, 0)
      else this.vel.z = pens.low ? Math.min(this.vel.z, 0) : Math.max(this.vel.z, 0)
      this.shake = Math.min(this.shake + 0.18, 0.5)
      if (this.districtCd <= 0) {
        this.districtCd = 2.5
        this.hooks.onToast(`🔒 ${d.name} — reach level ${d.minLevel}, or pay the toll`, 'warn')
        this.synth.denied()
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

  /** Border toll booth: pay cash once to enter a level-locked district forever. */
  private payToll(): void {
    const booth = this.nearLocked
    if (!booth) return
    const save = this.hooks.getSave()
    if (save.cash < booth.price) {
      this.synth.denied()
      this.hooks.onToast(`Toll is $${booth.price} — you only have $${Math.floor(save.cash)}. Take more jobs!`, 'warn')
      return
    }
    save.cash -= booth.price
    save.tollsPaid.push(booth.d.id)
    this.hooks.commit()
    this.synth.buy()
    this.hooks.onToast(`🎫 Toll paid — ${booth.d.name} is open to you now. Drive in!`, 'good')
    this.nearLocked = null
  }

  // =============== TRAFFIC ===============
  private updateTraffic(dt: number): void {
    for (const t of this.traffic) {
      const p = t.mesh.position
      // Player blocking ahead? (same lane, in front, close)
      const along = t.axis === 'x' ? p.x : p.z
      const playerAlong = t.axis === 'x' ? this.pos.x : this.pos.z
      const playerLat = t.axis === 'x' ? this.pos.z : this.pos.x
      const rel = (playerAlong - along) * t.dir
      const blocked = rel > 0 && rel < 11 && Math.abs(playerLat - t.lane) < 3 && this.pos.y < 2
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
      let target = blocked ? 0 : t.cruise
      if (lightCap !== null) target = Math.min(target, lightCap)
      const braking = blocked || (lightCap !== null && lightCap < t.speed)
      t.speed += (target - t.speed) * Math.min(dt * (braking ? 5 : 0.8), 1)
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
      if (t.nmCooldown <= 0 && dNow > 2.4 && dNow < 5.4 && playerSp > 17) {
        t.nmCooldown = 3
        this.addChain(30, 'Near miss')
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
            if (impact > 10) this.heat = Math.min(5, this.heat + 0.25)
          }
        }
      }
    }
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

    for (const d of this.drones) {
      d.bob += dt
      const toPlayer = new THREE.Vector3().subVectors(this.pos, d.pos)
      toPlayer.y = 0
      const dist = toPlayer.length()
      nearest = Math.min(nearest, dist)

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
      if (dist < 3.4 && this.pos.y < 2 && !this.busted && this.droneRamCd <= 0) {
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

    const speeding = sp * 3.6 > 95
    const effNearest = Math.min(nearest, this.cruiserNearest)
    if (speeding && effNearest < 45 && !this.busted) {
      this.heat = Math.min(5, this.heat + dt * 0.55)
    } else if (effNearest > 60 || !chased) {
      this.heat = Math.max(0, this.heat - dt * 0.28)
    }

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
    }
    this.lastHeatInt = heatInt

    // Busted meter: chased + slow + close (drones OR cruisers can box you in)
    const grabbed = nearest < 5.5 || this.cruiserNearest < 5
    if (this.heat >= 1 && grabbed && sp < 9 && !this.busted) {
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
    this.synth.busted()
    this.hooks.onBusted()
    this.hooks.onToast(`BUSTED — Harbor Patrol impounded your ride. Fine: $${fine}`, 'warn')
    this.pos.set(this.garagePos.x, 0, this.garagePos.z + 19)
    this.vel.set(0, 0, 0)
    this.heading = Math.PI
    this.clearMission()
  }

  // =============== MISSIONS ===============
  /** Road point that respects district gates: resamples until the target lies in
      a district the player's level can enter (missions must always be reachable). */
  private openPoint(rand: () => number, from: THREE.Vector3, dist: number): THREE.Vector3 {
    const save = this.hooks.getSave()
    let p = roadPoint(rand, from, dist)
    for (let i = 0; i < 10; i++) {
      const d = districtAt(p.x, p.z)
      if (!d || save.level >= d.minLevel) return p
      p = roadPoint(rand, from, dist)
    }
    return p
  }

  startMission(kind: 'delivery' | 'race' | 'taxi' | 'getaway'): void {
    const rand = Math.random
    const save = this.hooks.getSave()
    // Starting a new contract must never orphan the previous one's world props
    this.clearMission()
    this.synth.jobStart()
    if (kind === 'delivery') {
      const a = this.openPoint(rand, this.pos, 50)
      const b = this.openPoint(rand, a, 90)
      const timer = Math.round(a.distanceTo(b) / 9 + 26)
      this.mission = { kind, stage: 'pickup', a, b, timer, name: `Courier Run ${save.stats.deliveries + 1}` }
      this.hooks.onToast('Courier contract accepted — reach the pickup beacon', 'good')
    } else if (kind === 'taxi') {
      const a = this.openPoint(rand, this.pos, 40)
      const b = this.openPoint(rand, a, 90)
      const timer = Math.round(a.distanceTo(b) / 8 + 30)
      const passenger = this.makePassenger(a)
      this.mission = { kind, stage: 'pickup', a, b, timer, name: `Taxi Fare ${save.stats.fares + 1}`, passenger, dist: a.distanceTo(b) }
      this.hooks.onToast('Fare waiting — pick up your passenger at the beacon', 'good')
    } else if (kind === 'getaway') {
      // The contract starts hot: Patrol is already hunting you. Survive until the heat dies.
      this.heat = Math.max(this.heat, 3.2)
      this.mission = { kind, heat0: 3.2, name: `Getaway Contract ${save.stats.getaways + 1}` }
      this.hooks.onToast('The Patrol is onto this run — lose them and stay lost!', 'warn')
    } else {
      const cps: THREE.Vector3[] = []
      let prev = this.pos.clone()
      for (let i = 0; i < 8; i++) {
        const cp = this.openPoint(rand, prev, 55)
        cps.push(cp)
        prev = cp
      }
      this.mission = { kind, cps, idx: 0, timer: 14, total: 0, name: `Harbor GP ${save.stats.races + 1}` }
      this.hooks.onToast('Street race started — hit every gate before it closes!', 'good')
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
  private clearMission(): void {
    const m = this.mission
    if (m && m.kind === 'taxi' && m.passenger) this.scene.remove(m.passenger)
    this.mission = null
    this.markerBeacon.visible = false
  }

  cancelMission(): void {
    if (this.mission) {
      this.clearMission()
      this.hooks.onToast('Contract abandoned', 'warn')
    }
  }

  private updateMission(dt: number): void {
    const m = this.mission
    if (!m) {
      this.markerBeacon.visible = false
      return
    }
    if (m.kind !== 'getaway') {
      m.timer -= dt
      if (m.timer <= 0) {
        this.hooks.onToast(`${m.name} — FAILED (out of time)`, 'warn')
        this.synth.denied()
        this.clearMission()
        return
      }
    }
    if (m.kind === 'getaway') {
      // No beacon — the objective is the heat gauge itself. Stay free until it bleeds out.
      this.markerBeacon.visible = false
      if (this.heat < 0.8) {
        const reward = Math.round(300 + m.heat0 * 130)
        const save = this.hooks.getSave()
        save.stats.getaways += 1
        this.unlockAchievement('first-getaway')
        if (save.stats.getaways >= 5) this.unlockAchievement('getaway-5')
        this.grantCash(reward)
        this.grantXp(280)
        this.synth.missionDone()
        this.hooks.onMissionDone(m.name, reward)
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
          }
          this.synth.checkpoint()
          this.hooks.onToast(m.kind === 'taxi' ? 'Passenger aboard — get them there fast!' : 'Package secured — now DELIVER it!', 'good')
        } else if (m.kind === 'delivery') {
          const reward = Math.round(200 + m.a.distanceTo(m.b) * 0.9 + m.timer * 5)
          const save = this.hooks.getSave()
          save.stats.deliveries += 1
          this.unlockAchievement('first-delivery')
          if (save.stats.deliveries >= 10) this.unlockAchievement('delivery-10')
          this.grantCash(reward)
          this.grantXp(150)
          this.synth.missionDone()
          this.hooks.onMissionDone(m.name, reward)
          this.clearMission()
        } else {
          // Taxi fare: base + distance + tip from time remaining (speed pays)
          const fare = Math.round(120 + m.dist * 0.8 + m.timer * 4)
          const save = this.hooks.getSave()
          save.stats.fares += 1
          this.unlockAchievement('first-fare')
          this.grantCash(fare)
          this.grantXp(180)
          this.synth.missionDone()
          this.hooks.onMissionDone(m.name, fare)
          this.hooks.onToast(`Passenger dropped off — fare $${fare} (incl. speed tip)`, 'cash')
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
        m.timer = 14
        this.synth.checkpoint()
        if (m.idx >= m.cps.length) {
          const reward = Math.round(380 + m.total * 22)
          const save = this.hooks.getSave()
          save.stats.races += 1
          this.unlockAchievement('first-race')
          const raceTime = Math.round(8 * 14 - m.total)
          if (!save.stats.bestRace || raceTime < save.stats.bestRace) save.stats.bestRace = raceTime
          this.grantCash(reward)
          this.grantXp(320)
          this.synth.missionDone()
          this.hooks.onMissionDone(m.name, reward)
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
    const sp = this.vel.length()
    const dir = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))
    const target = this.pos.clone().addScaledVector(dir, -this.camDist).add(new THREE.Vector3(0, 4.4 + sp * 0.02, 0))
    this.camera.position.lerp(target, 1 - Math.exp(-dt * 5))
    const look = this.pos.clone().addScaledVector(dir, 7).add(new THREE.Vector3(0, 1.3, 0))
    if (this.shake > 0.01) {
      const s = this.shake
      look.x += (Math.random() - 0.5) * s
      look.y += (Math.random() - 0.5) * s
      this.camera.position.y += (Math.random() - 0.5) * s * 0.5
    }
    this.camera.lookAt(look)
    const targetFov = 62 + Math.min(sp * 0.45, 22) + (this.boosting ? 8 : 0)
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
      if (m.kind === 'delivery' || m.kind === 'taxi') {
        const t = m.stage === 'pickup' ? m.a : m.b
        mission = { kind: m.kind, name: m.name, timer: m.timer, dist: this.pos.distanceTo(t), stage: m.stage }
      } else if (m.kind === 'race') {
        const cp = m.cps[m.idx]
        mission = { kind: m.kind, name: m.name, timer: m.timer, dist: this.pos.distanceTo(cp), stage: `Gate ${m.idx + 1}/8` }
      } else {
        mission = { kind: m.kind, name: m.name, timer: -1, dist: 0, stage: `Heat ${Math.floor(this.heat)}★ — evade the Patrol!` }
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
    let tutorial: HudState['tutorial'] = null
    if (!save.tutorialDone && !this.attract) {
      if (this.tutSnapShards < 0) {
        this.tutSnapShards = save.shards.length
        this.tutSnapDeliveries = save.stats.deliveries
        this.tutSnapRaces = save.stats.races
      }
      const spKmh = this.vel.length() * 3.6
      const steering = this.keys.has('a') || this.keys.has('d') || this.keys.has('arrowleft') || this.keys.has('arrowright')
      const checks = [
        spKmh > 15,
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
        this.hooks.onToast('Tutorial complete — the harbor is yours. Good luck out there!', 'good')
      } else {
        if (this.tutLastIdx === -1) {
          this.hooks.onToast('Welcome to Neon Harbor — follow the FIRST NIGHT card up top', 'info')
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
      pursued: this.heat >= 1 && !this.busted && chasedClose,
      tutorial,
      mission,
      nearGarage: this.nearGarage,
      nearToll: this.nearLocked ? { name: this.nearLocked.d.name, price: this.nearLocked.price } : null,
      busted: this.busted,
      boosting: this.boosting,
      stuck: (this.stuckTime > 2 || this.stuckLatch > 0) && !this.busted,
    })
  }

  private drawMinimapBase(): void {
    const c = this.mmBase
    const ctx = c.getContext('2d')
    if (!ctx) return
    const W = c.width
    const scale = W / (SIZE + 16)
    const toPx = (v: number) => (v + HALF + 8) * scale
    ctx.fillStyle = '#04101c'
    ctx.fillRect(0, 0, W, W)
    ctx.fillStyle = '#0e1626'
    ctx.fillRect(toPx(-HALF - 4), toPx(-HALF - 4), (SIZE + 8) * scale, (SIZE + 8) * scale)
    ctx.fillStyle = '#1b2740'
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        ctx.fillRect(toPx(blockOrigin(i)), toPx(blockOrigin(j)), BLOCK * scale, BLOCK * scale)
      }
    }
  }

  private drawMinimap(): void {
    const ctx = this.mmCtx
    const W = this.mmCanvas.width
    ctx.clearRect(0, 0, W, W)
    ctx.drawImage(this.mmBase, 0, 0)
    const scale = W / (SIZE + 16)
    const toPx = (v: number) => (v + HALF + 8) * scale

    if (this.mission) {
      const m = this.mission
      let t: THREE.Vector3 | null = null
      if (m.kind === 'delivery' || m.kind === 'taxi') t = m.stage === 'pickup' ? m.a : m.b
      else if (m.kind === 'race') t = m.cps[m.idx]
      // getaway: no fixed target — the patrol dots on the HUD carry the info
      if (t) {
        ctx.fillStyle = '#facc15'
        ctx.beginPath()
        ctx.arc(toPx(t.x), toPx(t.z), 4, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.fillStyle = '#22d3ee'
    ctx.fillRect(toPx(this.garagePos.x) - 3, toPx(this.garagePos.z) - 3, 6, 6)
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
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.moveTo(0, -5.5)
    ctx.lineTo(3.6, 4)
    ctx.lineTo(-3.6, 4)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  /** PUBG-style full-screen tactical map. Drawn once when the player opens it
      (the engine is paused while the map is up, so a single static frame is
      enough and costs nothing per tick). */
  drawTacMap(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const S = canvas.width
    const EXT = 258 // city half-size (205) + beach strip
    const scale = S / (EXT * 2)
    const toPx = (v: number) => (v + EXT) * scale
    const save = this.hooks.getSave()
    const fs = (r: number) => `${Math.max(S * r, 9)}px system-ui, sans-serif`

    // ---- terrain: ocean, beach sand, city land ----
    ctx.fillStyle = '#0b2a40'
    ctx.fillRect(0, 0, S, S)
    ctx.fillStyle = '#8f7d54'
    ctx.fillRect(0, toPx(HALF + 5.5), S, (46 - 5.5) * scale)
    ctx.fillStyle = '#10182b'
    ctx.fillRect(toPx(-HALF - ROAD), toPx(-HALF - ROAD), (SIZE + ROAD * 2) * scale, (SIZE + ROAD * 2) * scale)

    // ---- roads (under the blocks so only the gaps show) ----
    const rc = (k: number) => -HALF + k * CELL + ROAD / 2 // road centerline
    ctx.strokeStyle = '#2c3a56'
    ctx.lineCap = 'butt'
    ctx.lineWidth = ROAD * scale
    for (let k = 0; k <= N; k++) {
      const p = toPx(rc(k))
      ctx.beginPath(); ctx.moveTo(p, toPx(-HALF)); ctx.lineTo(p, toPx(HALF)); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(toPx(-HALF), p); ctx.lineTo(toPx(HALF), p); ctx.stroke()
    }
    // the two central avenues — brighter, they carry the jersey barriers
    ctx.strokeStyle = '#54698c'
    ctx.lineWidth = ROAD * scale * 0.45
    for (const c of [rc(4), rc(5)]) {
      const p = toPx(c)
      ctx.beginPath(); ctx.moveTo(p, toPx(-HALF)); ctx.lineTo(p, toPx(HALF)); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(toPx(-HALF), p); ctx.lineTo(toPx(HALF), p); ctx.stroke()
    }

    // ---- city blocks + PUBG grid labels ----
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        ctx.fillStyle = i === GARAGE_I && j === GARAGE_J ? '#1e2d4c' : '#172138'
        ctx.fillRect(toPx(blockOrigin(i)), toPx(blockOrigin(j)), BLOCK * scale, BLOCK * scale)
      }
      const c = toPx(blockOrigin(i) + BLOCK / 2)
      ctx.fillStyle = '#5b6b8c'
      ctx.font = fs(0.02)
      ctx.fillText(String.fromCharCode(65 + i), c, S * 0.018)
      ctx.fillText(String(i + 1), S * 0.018, c)
    }

    // ---- districts: tinted zones with names + level locks ----
    const TINTS = ['rgba(34,211,238,0.06)', 'rgba(167,139,250,0.07)', 'rgba(74,222,128,0.06)', 'rgba(251,191,36,0.06)', 'rgba(244,114,182,0.07)']
    DISTRICTS.forEach((d, idx) => {
      const locked = save.level < d.minLevel && !save.tollsPaid.includes(d.id)
      const x = toPx(d.minX), y = toPx(d.minZ)
      const w = (d.maxX - d.minX) * scale, h = (d.maxZ - d.minZ) * scale
      ctx.fillStyle = locked ? 'rgba(255,51,85,0.07)' : TINTS[idx % TINTS.length]
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = locked ? 'rgba(255,51,85,0.45)' : 'rgba(148,163,184,0.28)'
      ctx.lineWidth = Math.max(S * 0.0012, 1)
      ctx.setLineDash([S * 0.012, S * 0.008])
      ctx.strokeRect(x, y, w, h)
      ctx.setLineDash([])
      ctx.fillStyle = locked ? '#ff8fa8' : '#9fb0d0'
      ctx.font = fs(0.024)
      ctx.fillText(locked ? `\u{1F512} ${d.name.toUpperCase()} \u00b7 LVL ${d.minLevel}` : d.name.toUpperCase(), x + w / 2, y + h / 2)
    })

    // ---- points of interest ----
    const dot = (x: number, z: number, r: number, color: string) => {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(toPx(x), toPx(z), r, 0, Math.PI * 2)
      ctx.fill()
    }
    // garage / job board
    ctx.fillStyle = '#22d3ee'
    const gx = toPx(this.garagePos.x), gz = toPx(this.garagePos.z)
    ctx.fillRect(gx - S * 0.008, gz - S * 0.008, S * 0.016, S * 0.016)
    ctx.font = fs(0.02)
    ctx.fillText('JOBS', gx, gz - S * 0.022)
    // mission target
    if (this.mission) {
      const m = this.mission
      let t: THREE.Vector3 | null = null
      if (m.kind === 'delivery' || m.kind === 'taxi') t = m.stage === 'pickup' ? m.a : m.b
      else if (m.kind === 'race') t = m.cps[m.idx]
      if (t) {
        dot(t.x, t.z, S * 0.011, '#facc15')
        ctx.strokeStyle = 'rgba(250,204,21,0.85)'
        ctx.lineWidth = Math.max(S * 0.002, 1.2)
        ctx.beginPath()
        ctx.arc(toPx(t.x), toPx(t.z), S * 0.018, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = '#facc15'
        ctx.font = fs(0.02)
        ctx.fillText(m.name.toUpperCase(), toPx(t.x), toPx(t.z) - S * 0.03)
      }
    }
    for (const s of this.shards) if (!s.taken) dot(s.mesh.position.x, s.mesh.position.z, Math.max(S * 0.003, 1.2), '#67e8f9')
    for (const c of this.crates) if (c.active) dot(c.mesh.position.x, c.mesh.position.z, Math.max(S * 0.004, 1.6), '#4ade80')
    for (const lm of this.landmarks) {
      ctx.fillStyle = lm.found ? '#3b3b5c' : '#c084fc'
      const px = toPx(lm.pos.x), pz = toPx(lm.pos.z), r = S * 0.007
      ctx.beginPath()
      ctx.moveTo(px, pz - r); ctx.lineTo(px + r, pz); ctx.lineTo(px, pz + r); ctx.lineTo(px - r, pz)
      ctx.closePath(); ctx.fill()
    }
    for (const d of this.drones) dot(d.pos.x, d.pos.z, Math.max(S * 0.004, 1.6), '#ff3355')
    if (this.heat > 0.5 && this.cruisers.length > 0) {
      const flash = Math.floor(this.time * 4) % 2 === 0
      let nearest: { x: number; z: number } | null = null
      let nearestD = Infinity
      for (const c of this.cruisers) {
        dot(c.pos.x, c.pos.z, S * 0.009, flash ? '#ff3355' : '#3b82f6')
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'
        ctx.lineWidth = Math.max(S * 0.0015, 1)
        ctx.beginPath()
        ctx.arc(toPx(c.pos.x), toPx(c.pos.z), S * 0.009, 0, Math.PI * 2)
        ctx.stroke()
        const dd = (c.pos.x - this.pos.x) ** 2 + (c.pos.z - this.pos.z) ** 2
        if (dd < nearestD) { nearestD = dd; nearest = c.pos }
      }
      if (nearest && this.heat >= 2) {
        ctx.strokeStyle = 'rgba(255,51,85,0.5)'
        ctx.lineWidth = Math.max(S * 0.002, 1.2)
        ctx.beginPath()
        ctx.arc(toPx(nearest.x), toPx(nearest.z), (26 + this.heat * 9) * scale, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // ---- player: view cone + arrow (map: x right, z down; facing = (sin h, cos h)) ----
    const px = toPx(this.pos.x), pz = toPx(this.pos.z)
    const hd = Math.atan2(Math.sin(this.heading), Math.cos(this.heading))
    const face = Math.atan2(Math.cos(hd), Math.sin(hd)) // polar angle of the facing vector on canvas
    ctx.fillStyle = 'rgba(255,255,255,0.13)'
    ctx.beginPath()
    ctx.moveTo(px, pz)
    ctx.arc(px, pz, S * 0.09, face - 0.5, face + 0.5)
    ctx.closePath()
    ctx.fill()
    ctx.save()
    ctx.translate(px, pz)
    ctx.rotate(face + Math.PI / 2) // the arrow shape points -y; swing it onto the facing angle
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'
    ctx.lineWidth = Math.max(S * 0.0015, 1)
    const a = S * 0.014
    ctx.beginPath()
    ctx.moveTo(0, -a)
    ctx.lineTo(a * 0.62, a * 0.75)
    ctx.lineTo(0, a * 0.35)
    ctx.lineTo(-a * 0.62, a * 0.75)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.restore()

    // ---- frame, compass, legend ----
    ctx.strokeStyle = 'rgba(226,232,240,0.5)'
    ctx.lineWidth = Math.max(S * 0.002, 1.5)
    ctx.strokeRect(S * 0.035, S * 0.035, S * 0.93, S * 0.93)
    ctx.fillStyle = '#e2e8f0'
    ctx.font = `bold ${Math.max(S * 0.026, 11)}px system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.fillText('\u2191 N', S * 0.045, S * 0.062)
    ctx.textAlign = 'center'
    ctx.fillText('NEON HARBOR \u2014 TACTICAL MAP', S / 2, S * 0.965)
    ctx.font = fs(0.018)
    ctx.fillStyle = '#8fa0c0'
    ctx.fillText('YOU \u25b2   JOBS \u25a0   MISSION \u25cf   SHARDS \u00b7   CRATES \u00b7   LANDMARKS \u25c6   PATROL \u25cf', S / 2, S * 0.985)
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
      if (dist < 3.3 && this.pos.y < 2 && !this.busted && this.cruiserRamCd <= 0) {
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
    const STREET = 88
    const BEACH = 22
    const rand = seededRand(4321)
    const charKeys = Object.keys(this.assets.chars)
    if (charKeys.length === 0) return
    // Muted, realistic street-wear palette — keeps the crowd from looking cartoonish
    const tints = [0xb9bec6, 0x8f867b, 0x6d7683, 0x7d6f7a, 0x5f6b5d, 0x9c8f7d, 0x565e6b, 0xa89f8d, 0x4f5a67]
    for (let i = 0; i < STREET + BEACH; i++) {
      const beach = i >= STREET
      const key = charKeys[Math.floor(rand() * charKeys.length)]
      const { obj, clips } = cloneCharacter(this.assets, key)
      // Realistic height spread 1.62–1.9m, feet on the ground (no clone-stamp crowd)
      const bb = new THREE.Box3().setFromObject(obj)
      const h = bb.max.y - bb.min.y
      const targetH = 1.62 + rand() * 0.28
      const s = h > 0.01 ? targetH / h : 1
      obj.scale.setScalar(s)
      // Individual muted tint with slight brightness spread (materials are cloned)
      const tint = new THREE.Color(tints[Math.floor(rand() * tints.length)])
      tint.multiplyScalar(0.82 + rand() * 0.36)
      obj.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          const src = m.material as THREE.MeshStandardMaterial
          const mat = src.clone()
          mat.color = tint.clone()
          m.material = mat
        }
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
        dog: undefined as THREE.Group | undefined,
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
      p.mixer.update(dt)
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
        this.vel.multiplyScalar(0.82)
        this.shake = Math.min(this.shake + 0.35, 0.8)
        this.heat = Math.min(5, this.heat + 1)
        this.synth.thud()
        this.hooks.onToast('You hit a pedestrian! Patrol alerted (+1★)', 'warn')
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

type District = 'downtown' | 'market' | 'docks' | 'oldtown'

function districtOf(i: number, j: number): District {
  if (Math.abs(i - GARAGE_I) <= 1 && Math.abs(j - GARAGE_J) <= 1) return 'downtown'
  if (j >= 6) return 'docks'
  if (i >= 6) return 'market'
  return 'oldtown'
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

/** Canvas texture: neon billboard sign. */
function makeSignTexture(text: string, color: string): THREE.Texture {
  const cv = document.createElement('canvas')
  cv.width = 256
  cv.height = 128
  const ctx = cv.getContext('2d')
  if (!ctx) return new THREE.CanvasTexture(cv)
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
  return new THREE.CanvasTexture(cv)
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
