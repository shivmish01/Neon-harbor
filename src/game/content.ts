// ============================================================
// NEON HARBOR — content catalog
// Skins (car paints), environment themes, economy constants.
// Premium = locked; unlocked with VCoins on vplay.gg (prices are
// owned by vplay.gg and arrive via the SDK) or earned in-game.
// ============================================================

export interface Skin {
  id: string
  name: string
  desc: string
  price: number // in-game cash; 0 = not sold for cash
  premium: boolean // locked until unlocked via vplay.gg entitlement
  minLevel: number
  body: number // car paint color (hex)
  glow: number // underglow / trail color (hex)
  model?: string // Kenney car-kit model id (default sedan-sports)
  vcId?: string // vplay.gg item id; undefined = not sold on vplay.gg
  earned?: boolean // prestige paint unlocked by in-game feats, never sold
}

export interface Theme {
  id: string
  name: string
  desc: string
  price: number // in-game cash; 0 = not sold for cash
  premium: boolean
  sky: number
  fog: number
  fogDensity: number
  ambient: number
  ambientIntensity: number
  moon: number
  moonIntensity: number
  ground: number
  water: number
  rain: boolean
  vcId?: string // vplay.gg item id
}

export const HARBOR_PASS_ID = 'pass.harbor'
export const HARBOR_PASS_ITEMS = ['ghost', 'royal', 'solar', 'oni', 'acid', 'sakura']
export const AURORA_REQUIREMENT = 'Earn all 15 achievements and reach level 10'
export const GAME_VERSION = 'v1.6.0'
export const GAME_TITLE = 'NEON HARBOR'

// ============================================================
// WORLD CIRCUIT (v2) — one endless run through real cities
// The odometer never resets. Every ZONE_LENGTH_KM the world
// transforms into the next real city (skyline silhouette,
// landmark, architecture mood, window glow). After 7 cities
// the circuit loops with a "New Horizon" lap.
// ============================================================
export const ZONE_LENGTH_KM = 6 // km per city zone (~3.5 min at cruise)

export interface WorldZone {
  id: string
  name: string
  tag: string
  landmark: string
  unlockLevel: number // city jobs/bonuses open at this level; driving through is always free
  facade: string // distant skyline facade base color (hex)
  litWarm: number // 0..1 — warm vs cool window glow balance
  trim: number // neon accent color (hex) for skyline edges + chips
  mood: [number, number, number] // building instance tint (rgb factors)
  win: [string, string] // window warm / cool colors
  sign: string[] // billboard-flavour text used on the map + banner
  road: string // asphalt tint (hex) — each city's tarmac has its own character
  arch?: WorldArch // v2.1 per-city architecture style pack
}

/** Per-city architecture pack — the v2.1 "every city looks different" pass.
    Each zone gets its own roof silhouette, window grid, street dress and
    traffic mix so London never reads as Tokyo. */
export interface WorldArch {
  roof: 'flat' | 'tank' | 'pitched' | 'mansard' | 'pagoda' | 'parapet'
  cap: number // roof cap base color (hex)
  capGlow: number // emissive edge for parapet/roof glow (0 = none)
  balcony?: boolean // balconies under window rows (Paris/Mumbai)
  stringLights?: number // 0..1 festive string-light density on facades (Mumbai)
  tankChance?: number // 0..1 water-tank chance on rooflines (Harbor/Mumbai)
  neonDensity: number // 0..1.5 sign density multiplier vs the base city
  neonPalette: number[] // sign colours for this city
  winOffset: number // window-grid seed offset — every city's glows differently
  people: string[] // crowd re-tint accents (hex) — London coats vs Mumbai saris
  traffic: string[] // car style mix (sedan/hatch/van/taxi/sport/bus/tuk)
  trafficColors: Record<string, number[]> // body colours per style for this city
  trafficCount?: number
  /** Skyline silhouette DNA — how this city reshapes the SAME building
      footprints: base height multiplier, variance spread, tower chance and how
      tall towers grow. London flattens into terraces; New York rises into
      steel canyons; Tokyo packs every block into towers. */
  heightProfile?: { base: number; spread: number; towerChance: number; towerScale: number }
  /** Atmosphere override — the fog that sits between the player and the
      city. Each city breathes its own air: London haze, Tokyo pink gloom,
      New York deep blue. (Theme still owns the sky base; fog/lane/walk
      override it on arrival.) */
  fog?: string
  fogDensity?: number
  laneCol?: number // lane paint colour
  walkCol?: number // sidewalk colour
  /** Street furniture set — what lives on THIS city's sidewalks. */
  furniture?: 'booth' | 'vending' | 'stall' | 'awning' | 'lantern' | 'steam' | 'phonebox' | 'none'
  /** Glass-curtain towers — thin lit vertical strips on the tallest towers
      (Tokyo / New York / Beijing read as modern office canyons at night). */
  glassStrips?: boolean
  /** Local headgear for the street people — bowler hats in London, conical
      bamboo hats in Beijing, turbans in Mumbai, beanies in New York. */
  headgear?: 'bowler' | 'cone' | 'turban' | 'cap' | 'beanie' | 'beret' | 'none'
  /** Weathered wall material — what the facades are MADE of, drawn as a
      grayscale texture and hued by the zone mood (brick London, plaster
      Paris, stone Beijing, stucco Mumbai, panel Tokyo). */
  mass?: number // 0..1 — how much of its lot each building covers (1 = tight canyon, low = wide avenue)
  flyover?: { lane: number; a0: number; a1: number; h: number; rail: boolean } // driveable elevated deck: lane index, along-range, deck height, edge rails?
  facadeKind?: 'brick' | 'stone' | 'concrete' | 'plaster' | 'stucco' | 'panel'
  /** Facade paint — base wall color + accent trim, baked into the weathered
      texture so every city's walls read as a DIFFERENT material at a glance
      (slate Harbor, red-brick London, cream Paris, stone Beijing, ochre
      Mumbai, pale panels Tokyo, dark brick New York). */
  facadeBase?: number
  facadeAccent?: number
  /** Body mesh beyond the head — the outfit that makes a local crowd read
      local even before you see their hat (overcoat London, scarf Beijing,
      dupatta Mumbai, backpack Tokyo, apron Paris, hoodie New York, jacket Harbor). */
  garment?: 'jacket' | 'overcoat' | 'apron' | 'scarf' | 'dupatta' | 'backpack' | 'hoodie'
  /** Skyline signature shapes — each city crowns its towers differently. */
  setbacks?: boolean // New York stepped skyscraper crowns
  antennas?: boolean // Tokyo needle antennas
  eaveTiers?: boolean // Beijing tiered pagoda eaves
  dishes?: number // Mumbai rooftop dish density 0..1
  /** Time of day — every city lives in its own light. Night keeps the player's
      theme; Dusk runs a warm golden-hour blend; Day runs a bright sun blend
      (sky, fog, ambient, sun, headlights, window glow all flip). */
  hour?: 'night' | 'dusk' | 'day'
}

export const WORLD_ZONES: WorldZone[] = [
  { id: 'harbor',  name: 'Harbor',  tag: 'Home port — neon skies, salt air',                landmark: 'The Lighthouse',  unlockLevel: 1, facade: '#2a3442', litWarm: 0.75, trim: 0x22d3ee, mood: [0.5, 0.6, 0.95],   win: ['#ffd9a0', '#bfe0ff'], sign: ['NEON HARBOR', 'DOCK 7', 'WELCOME'], road: '#1d222c',
    arch: { roof: 'tank', cap: 0x11141f, capGlow: 0, tankChance: 0.3, mass: 0.78, flyover: { lane: 4, a0: -180, a1: 180, h: 8, rail: false }, neonDensity: 1, neonPalette: [0x22d3ee, 0xff2d95, 0xa3e635, 0xf97316, 0xfde047], winOffset: 0, people: ['#2a9d8f', '#d4a017', '#e76f51', '#4a6fa5'], traffic: ['sedan', 'hatch', 'van', 'sport', 'taxi', 'sedan', 'bus'], trafficColors: { sedan: [0x4f7fb8, 0xb85c7a, 0x5aa88f, 0xc9cdd6, 0x7a6fc9], hatch: [0xe23b3b, 0x2f9fd8, 0xf0a020, 0x4fbf67, 0xa06fd8], van: [0xb8c0cc, 0x6fa35f, 0x4f8fb8], sport: [0xfacc15, 0x22d3ee, 0xff4d6d], taxi: [0xf59e0b], bus: [] }, trafficCount: 22, heightProfile: { base: 1, spread: 0.15, towerChance: 0.2, towerScale: 1.6 }, fog: '#0e1526', fogDensity: 0.006, laneCol: 0x3f4b66, walkCol: 0x1c2334, furniture: 'none', headgear: 'cap', facadeKind: 'concrete', facadeBase: 0x4a5a72, facadeAccent: 0x22d3ee, garment: 'jacket', hour: 'night' } },
  { id: 'london',  name: 'London',  tag: 'Brick terraces, black cabs, the old clock',       landmark: 'Big Ben',         unlockLevel: 2, facade: '#3a2a24', litWarm: 0.95, trim: 0xe0504a, mood: [1.0, 0.42, 0.28], win: ['#ffce8a', '#9fc4ff'], sign: ['MIND THE GAP', 'UNDERGROUND', 'ROYAL MAIL'], road: '#151a22',
    arch: { roof: 'pitched', cap: 0x2f3540, capGlow: 0, neonDensity: 0.35, mass: 0.94, flyover: { lane: 5, a0: -120, a1: 120, h: 7, rail: false }, neonPalette: [0xe0504a, 0xfde047, 0x9fc4ff], winOffset: 11, people: ['#2f3542', '#3b4a63', '#8a93a6', '#14161c'], traffic: ['bus', 'sedan', 'sedan', 'taxi', 'hatch', 'bus', 'sedan'], trafficColors: { sedan: [0x14161c, 0x23262e, 0x2c3038, 0x3a3f4a], hatch: [0x3a3f4a, 0x4a4f5a, 0x565d6a], taxi: [0xf59e0b], bus: [] }, trafficCount: 22, heightProfile: { base: 0.6, spread: 0.12, towerChance: 0.05, towerScale: 1.8 }, fog: '#1a1418', fogDensity: 0.0074, laneCol: 0x59533f, walkCol: 0x241f1b, furniture: 'phonebox', headgear: 'bowler', facadeKind: 'brick', facadeBase: 0x8a3428, facadeAccent: 0xdfe0e8, garment: 'overcoat', hour: 'dusk' } },
  { id: 'paris',   name: 'Paris',   tag: 'Cream façades, café lights, iron towers',         landmark: 'Eiffel Tower',    unlockLevel: 3, facade: '#4a3f30', litWarm: 0.6,  trim: 0xd9b98a, mood: [1.0, 0.92, 0.72],  win: ['#ffd9a0', '#cfe8ff'], sign: ['MÉTRO', 'CAFÉ', 'BOULANGERIE'], road: '#1b1a20',
    arch: { roof: 'mansard', cap: 0x2a2f3a, capGlow: 0, balcony: true, mass: 0.84, flyover: { lane: 4, a0: -110, a1: 110, h: 7, rail: true }, neonDensity: 0.55, neonPalette: [0xd9b98a, 0xffd9a0, 0x9fd8ff], winOffset: 23, people: ['#e8ddc8', '#b8a888', '#3b4a63', '#8a93a6'], traffic: ['sedan', 'hatch', 'sedan', 'van', 'hatch', 'sport'], trafficColors: { sedan: [0xc9c0a8, 0xa8b4a8, 0x8a94a6, 0x9a8a6a], hatch: [0xb0a0c0, 0xc9b458, 0xa8563f, 0x5a6e8c], van: [0xb8c0cc, 0xa8b4a8], sport: [0x3f7a6e, 0x6b5a8c] }, trafficCount: 20, heightProfile: { base: 0.8, spread: 0.06, towerChance: 0.04, towerScale: 1.6 }, fog: '#1c150e', fogDensity: 0.0064, laneCol: 0x565241, walkCol: 0x282019, furniture: 'awning', headgear: 'beret', facadeKind: 'plaster', facadeBase: 0xe6e0d2, facadeAccent: 0x565d6a, garment: 'apron', hour: 'night' } },
  { id: 'beijing', name: 'Beijing', tag: 'Golden rooflines, lantern-lit avenues',           landmark: 'Golden Pagoda',   unlockLevel: 4, facade: '#3f3020', litWarm: 0.85, trim: 0xefb63c, mood: [1.0, 0.66, 0.28], win: ['#ffe3a8', '#a8c8ff'], sign: ['故宫', '王府井', '三里屯'], road: '#181c22',
    arch: { roof: 'pagoda', cap: 0xcfb457, capGlow: 0x8a6a1e, glassStrips: true, mass: 0.72, flyover: { lane: 5, a0: -200, a1: 200, h: 8, rail: true }, eaveTiers: true, neonDensity: 1.15, neonPalette: [0xefb63c, 0xff6a3d, 0xa3e635], winOffset: 31, people: ['#9a2e24', '#cfb457', '#2a9d8f', '#7b2d43'], traffic: ['sedan', 'van', 'bus', 'sedan', 'hatch'], trafficColors: { sedan: [0x8a2020, 0xa8543f, 0x3f4a5e, 0x565d6a], hatch: [0x6a7a5a, 0x9a8a52, 0x4a5a72], van: [0x3f4a5e, 0x6a7a5a], bus: [] }, trafficCount: 16, heightProfile: { base: 0.85, spread: 0.18, towerChance: 0.15, towerScale: 1.9 }, fog: '#160f0c', fogDensity: 0.0062, laneCol: 0x4d4232, walkCol: 0x221a12, furniture: 'lantern', headgear: 'cone', facadeKind: 'stone', facadeBase: 0x8e8e94, facadeAccent: 0xa82020, garment: 'scarf', hour: 'day' } },
  { id: 'mumbai',  name: 'Mumbai',  tag: 'Saffron streets, tuk-tuks, sea breeze',           landmark: 'Gateway of India',unlockLevel: 5, facade: '#46271f', litWarm: 0.9,  trim: 0xf08c3a, mood: [1.0, 0.6, 0.4],   win: ['#ffd9a0', '#a8e0c8'], sign: ['TUK TUK', 'CHAI', 'MARINE DRIVE'], road: '#1c1715',
    arch: { roof: 'tank', cap: 0x14161c, capGlow: 0, balcony: true, stringLights: 0.5, mass: 0.92, flyover: { lane: 4, a0: -100, a1: 100, h: 6.5, rail: false }, tankChance: 0.4, dishes: 0.6, neonDensity: 1.2, neonPalette: [0xf08c3a, 0xff7f6b, 0x2a9d8f, 0xd4a017, 0xff6aa7], winOffset: 47, people: ['#f08c3a', '#ff7f6b', '#2a9d8f', '#d4a017', '#7b2d43'], traffic: ['tuk', 'tuk', 'hatch', 'sedan', 'tuk', 'hatch'], trafficColors: { tuk: [0xf08c3a, 0x2a9d8f, 0xff7f6b, 0xd4a017, 0x4a6fa5], hatch: [0xff7f6b, 0xd4a017, 0x2a9d8f, 0xe76f51, 0x9b8ac4], sedan: [0x8a93a6, 0x6a7f4e, 0x5a6e8c] }, trafficCount: 20, heightProfile: { base: 0.62, spread: 0.3, towerChance: 0.12, towerScale: 2.2 }, fog: '#170e0b', fogDensity: 0.0068, laneCol: 0x4a3f35, walkCol: 0x1e1612, furniture: 'stall', headgear: 'turban', facadeKind: 'stucco', facadeBase: 0xf0eae0, facadeAccent: 0x2a9d8f, garment: 'dupatta', hour: 'dusk' } },
  { id: 'tokyo',   name: 'Tokyo',   tag: 'Pink neon towers, the red tower, midnight ramen', landmark: 'Tokyo Tower',     unlockLevel: 6, facade: '#33212e', litWarm: 0.5,  trim: 0xff6aa7, mood: [0.72, 0.45, 1.0],   win: ['#ffd9a0', '#ffc2e0'], sign: ['渋谷', '東京タワー', 'ネオン横丁'], road: '#131720',
    arch: { roof: 'parapet', cap: 0x2b2735, capGlow: 0xff6aa7, glassStrips: true, antennas: true, mass: 0.9, flyover: { lane: 5, a0: -130, a1: 130, h: 7.5, rail: true }, neonDensity: 1.5, neonPalette: [0xff6aa7, 0x22d3ee, 0xfde047, 0xa78bfa], winOffset: 59, people: ['#e8e8f0', '#14161c', '#3b4a63', '#565d6a'], traffic: ['taxi', 'sedan', 'sedan', 'hatch', 'van', 'taxi'], trafficColors: { taxi: [0xf59e0b], sedan: [0xe8e8f0, 0x14161c, 0x8a93a6, 0x3a3f4a], hatch: [0x9b8ac4, 0x565d6a, 0xc9cdd6], van: [0x8a93a6, 0x565d6a] }, trafficCount: 20, heightProfile: { base: 1.15, spread: 0.2, towerChance: 0.35, towerScale: 1.6 }, fog: '#140a14', fogDensity: 0.0056, laneCol: 0x4a3d52, walkCol: 0x1e1726, furniture: 'vending', headgear: 'cap', facadeKind: 'panel', facadeBase: 0x9aa0b2, facadeAccent: 0xff6aa7, garment: 'backpack', hour: 'night' } },
  { id: 'newyork', name: 'New York',tag: 'Steel canyons, yellow cabs, lights that never sleep', landmark: 'Empire State', unlockLevel: 7, facade: '#26354a', litWarm: 0.35, trim: 0x6ea8ff, mood: [0.4, 0.58, 1.0],   win: ['#ffe0a0', '#9fd4ff'], sign: ['TIMES SQ', 'BROADWAY', 'NYPD'], road: '#10141d',
    arch: { roof: 'parapet', cap: 0x1b2433, capGlow: 0x6ea8ff, glassStrips: true, setbacks: true, mass: 0.9, flyover: { lane: 4, a0: -150, a1: 150, h: 8, rail: true }, neonDensity: 0.7, neonPalette: [0x6ea8ff, 0xff4d6d, 0xfde047, 0x22d3ee], winOffset: 71, people: ['#8a93a6', '#3b4a63', '#14161c', '#f59e0b'], traffic: ['taxi', 'sedan', 'sedan', 'van', 'sport', 'taxi', 'sedan'], trafficColors: { taxi: [0xf59e0b], sedan: [0x8d99ae, 0x5a6e8c, 0x2f3a4a, 0xc9cdd6], van: [0x98a5b5, 0x5a6e8c], sport: [0x6ea8ff, 0xfacc15, 0xff4d6d] }, trafficCount: 22, heightProfile: { base: 1.3, spread: 0.25, towerChance: 0.45, towerScale: 1.5 }, fog: '#0a0f20', fogDensity: 0.0058, laneCol: 0x3d4e70, walkCol: 0x151b2c, furniture: 'steam', headgear: 'beanie', facadeKind: 'brick', facadeBase: 0x7a5548, facadeAccent: 0x6ea8ff, garment: 'hoodie', hour: 'day' } },
]

export interface ZoneState {
  zone: WorldZone
  index: number // 0..6 position on the circuit
  lap: number // how many full laps of the circuit completed
  kmInto: number // km driven inside the current zone
  kmToNext: number // km until the next city
}

/** Where on the World Circuit a given total-run distance sits. */
export function zoneAt(totalKm: number): ZoneState {
  const lapLen = ZONE_LENGTH_KM * WORLD_ZONES.length
  const km = Math.max(0, totalKm)
  const lap = Math.floor(km / lapLen)
  const inLap = km - lap * lapLen
  const index = Math.min(WORLD_ZONES.length - 1, Math.floor(inLap / ZONE_LENGTH_KM))
  const kmInto = inLap - index * ZONE_LENGTH_KM
  return { zone: WORLD_ZONES[index], index, lap, kmInto, kmToNext: Math.max(0, ZONE_LENGTH_KM - kmInto) }
}

// ============================================================
// BREAKDOWNS (v2) — every WRECK breaks something real
// Game over = a part fails. The wreck card names it, the part
// carries a driving penalty until the garage fixes it, and the
// run (odometer + zone) is never reset — you fix it and continue
// the same map. First repair of a save is free.
// ============================================================
export interface BreakdownDef {
  id: string
  name: string
  icon: string
  desc: string // what happened to the car (wreck card)
  effect: string // gameplay cost until repaired
  baseCost: number // repair cost at the Harbor; ×(1+0.5×zoneIndex) further out
  weight: number // weighted random pick on WRECK
}

export const BREAKDOWNS: BreakdownDef[] = [
  { id: 'engine',      name: 'Engine Block',    icon: '🔧', desc: 'The block cracked under the heat.',                  effect: 'Top speed & acceleration −12%',      baseCost: 260, weight: 0.2 },
  { id: 'tires',       name: 'Tires',           icon: '🛞', desc: 'A tire blew — grip is gone.',                         effect: 'Cornering grip −15%',                baseCost: 200, weight: 0.18 },
  { id: 'brakes',      name: 'Brakes',          icon: '🛑', desc: 'A brake line snapped.',                              effect: 'Stopping power −30%',                baseCost: 190, weight: 0.16 },
  { id: 'nitro',       name: 'Nitro Injector',  icon: '⚡', desc: 'The injector backfired — boost leaks fast.',         effect: 'Nitro drains +35%, refills slower',  baseCost: 240, weight: 0.12 },
  { id: 'suspension',  name: 'Suspension',      icon: '🦘', desc: 'A strut bent — the ride wobbles on jumps.',          effect: 'Jumps launch −20%',                  baseCost: 230, weight: 0.12 },
  { id: 'steering',    name: 'Steering Rack',   icon: '🎛️', desc: 'The rack seized — turns come slow.',                effect: 'Steering −18%',                     baseCost: 210, weight: 0.1 },
  { id: 'radiator',    name: 'Radiator',        icon: '🌡️', desc: 'The radiator split — the engine runs hot.',         effect: 'Damage taken +15%',                  baseCost: 220, weight: 0.07 },
  { id: 'lights',      name: 'Headlights',      icon: '💡', desc: 'The headlights blew — night runs go dark.',         effect: 'Night vision crippled until fixed', baseCost: 160, weight: 0.05 },
]

export function breakdownById(id: string | null | undefined): BreakdownDef | null {
  if (!id) return null
  return BREAKDOWNS.find((b) => b.id === id) ?? null
}

/** Weighted random part failure on WRECK. Never the same part twice in a row. */
export function rollBreakdown(prevId: string | null): string {
  const pool = BREAKDOWNS.filter((b) => b.id !== prevId)
  const total = pool.reduce((s, b) => s + b.weight, 0)
  let r = Math.random() * total
  for (const b of pool) {
    r -= b.weight
    if (r <= 0) return b.id
  }
  return pool[pool.length - 1].id
}

/** Repair cost of a broken part — distance from home makes the bill real. */
export function breakdownCost(bd: BreakdownDef, zoneIndex: number): number {
  return Math.round(bd.baseCost * (1 + 0.5 * zoneIndex))
}

export interface BreakdownMuls {
  accel: number
  top: number
  grip: number
  steer: number
  brake: number
  nitroDrain: number
  nitroRegen: number
  launch: number
  dmg: number
}
const MUL_ONE: BreakdownMuls = { accel: 1, top: 1, grip: 1, steer: 1, brake: 1, nitroDrain: 1, nitroRegen: 1, launch: 1, dmg: 1 }
const BREAKDOWN_MULS: Record<string, Partial<BreakdownMuls>> = {
  engine: { accel: 0.88, top: 0.88 },
  tires: { grip: 0.85, steer: 0.85 },
  brakes: { brake: 0.7 },
  nitro: { nitroDrain: 1.35, nitroRegen: 0.8 },
  suspension: { launch: 0.8 },
  steering: { steer: 0.82 },
  radiator: { dmg: 1.15 },
  lights: {},
}
export function breakdownMuls(id: string | null | undefined): BreakdownMuls {
  const p = id ? BREAKDOWN_MULS[id] : undefined
  return p ? { ...MUL_ONE, ...p } : MUL_ONE
}

// ---------- PERFORMANCE UPGRADES (cash-only — earned in-game, never VCoins) ----------
export type UpgradeId = 'engine' | 'nitro' | 'tires' | 'armor' | 'suspension' | 'horn'
export interface UpgradeDef {
  id: UpgradeId
  name: string
  desc: string
  icon: string
  prices: number[] // cash price of the NEXT level (index = current level)
  max: number
}
export const UPGRADES: UpgradeDef[] = [
  { id: 'engine',     name: 'Engine Tune',  desc: 'More top speed, harder acceleration',              icon: '🔧', prices: [800, 1800, 3500], max: 3 },
  { id: 'nitro',      name: 'Nitro Kit',    desc: 'Boost lasts longer, refills faster',               icon: '⚡', prices: [600, 1500, 3000], max: 3 },
  { id: 'tires',      name: 'Grip Tires',   desc: 'Sharper cornering, less slide',                    icon: '🛞', prices: [500, 1200, 2500], max: 3 },
  { id: 'armor',      name: 'Roll Cage',    desc: 'Reinforced body — crashes hurt 15% less per level', icon: '🛡️', prices: [700, 1600, 3200], max: 3 },
  { id: 'suspension', name: 'Stunt Suspension', desc: 'Ramps launch you further, landings stay glued', icon: '🦘', prices: [650, 1400, 2800], max: 3 },
  { id: 'horn',       name: 'Air Horns',    desc: 'Louder blast — pedestrians scatter from further',   icon: '📯', prices: [300, 900, 2000],  max: 3 },
]
export const ENGINE_MUL = (lv: number) => 1 + 0.09 * lv
export const NITRO_REGEN_MUL = (lv: number) => 1 + 0.35 * lv
export const NITRO_DRAIN_MUL = (lv: number) => 1 / (1 + 0.22 * lv)
export const TIRES_MUL = (lv: number) => 1 + 0.07 * lv
export const ARMOR_MUL = (lv: number) => 1 - 0.15 * lv
export const LAUNCH_MUL = (lv: number) => 1 + 0.12 * lv
export const HORN_RANGE = (lv: number) => 15 + 4 * lv

// ---------- CAR SKINS ----------
export const SKINS: Skin[] = [
  { id: 'stock',    name: 'Harbor Gray',   desc: 'Factory fresh port-runner coupe.',        price: 0,   premium: false, minLevel: 1, body: 0x8a93a6, glow: 0x22d3ee },
  { id: 'blue',     name: 'Midnight Blue', desc: 'Deep-sea metallic with cyan underglow.',  price: 300, premium: false, minLevel: 1, body: 0x1d4ed8, glow: 0x38bdf8, vcId: 'skin.blue' },
  { id: 'amber',    name: 'Taxi Amber',    desc: 'Ride-share legend. Smells like hustle.',  price: 450, premium: false, minLevel: 1, body: 0xf59e0b, glow: 0xfde047, model: 'taxi', vcId: 'skin.amber' },
  { id: 'white',    name: 'Rally White',   desc: 'Clean, loud, and gone before the echo.',  price: 600, premium: false, minLevel: 1, body: 0xf1f5f9, glow: 0x4ade80, model: 'hatchback-sports', vcId: 'skin.white' },
  { id: 'viper',    name: 'Viper Green',   desc: 'Toxic avenger of the dock district.',     price: 900, premium: false, minLevel: 1, body: 0x16a34a, glow: 0xa3e635, model: 'suv', vcId: 'skin.viper' },
  { id: 'ghost',    name: 'Crimson Ghost', desc: 'The patrol hates this one.',              price: 0,   premium: true,  minLevel: 1, body: 0x9f1239, glow: 0xfb7185, model: 'race', vcId: 'skin.ghost' },
  { id: 'royal',    name: 'Royal Violet',  desc: 'Harbor-night royalty.',                   price: 0,   premium: true,  minLevel: 1, body: 0x6d28d9, glow: 0xc084fc, model: 'suv-luxury', vcId: 'skin.royal' },
  { id: 'solar',    name: 'Solar Flare',   desc: 'Molten gold, zero subtlety.',             price: 0,   premium: true,  minLevel: 1, body: 0xd97706, glow: 0xfbbf24, model: 'race', vcId: 'skin.solar' },
  { id: 'oni',      name: 'Cyber Oni',     desc: 'Matte black, demon neon.',                price: 0,   premium: true,  minLevel: 1, body: 0x111114, glow: 0xff2d95, model: 'race', vcId: 'skin.oni' },
  { id: 'aurora',   name: 'Aurora Prime',  desc: 'Prestige chasing-light paint. ' + AURORA_REQUIREMENT + '.', price: 0, premium: true, earned: true, minLevel: 1, body: 0x0ea5e9, glow: 0xa5f3fc, model: 'race' },
]

// ---------- ENVIRONMENT THEMES ----------
export const THEMES: Theme[] = [
  {
    id: 'midnight', name: 'Midnight Rain', desc: 'The classic. Neon reflections, warm rain.',
    price: 0, premium: false,
    // Vibrant Night City pass (QA brief 2026-10-12): asphalt lifted from
    // near-black to readable charcoal #20242D, sky to deep navy #080F20 —
    // night stays moody but roads, markings and props no longer crush to black.
    sky: 0x080f20, fog: 0x101a30, fogDensity: 0.006,
    ambient: 0x41527a, ambientIntensity: 1.55, moon: 0x9cc0ff, moonIntensity: 1.1,
    ground: 0x20242d, water: 0x0d2c40, rain: true,
  },
  {
    id: 'day', name: 'Harbor Day', desc: 'Bright sun, blue water, the port wide awake.',
    price: 0, premium: false,
    sky: 0x8ec8f0, fog: 0xaed4ee, fogDensity: 0.0011,
    ambient: 0xcfe0f5, ambientIntensity: 0.7, moon: 0xfff3da, moonIntensity: 1.7,
    ground: 0x8b95a1, water: 0x3f7fab, rain: false,
  },
  {
    id: 'golden', name: 'Golden Hour', desc: 'The harbor at eternal sunset. Earned, not given.',
    price: 800, premium: false, vcId: 'theme.golden',
    sky: 0x2a1608, fog: 0x58290a, fogDensity: 0.0065,
    ambient: 0xffb26b, ambientIntensity: 1.2, moon: 0xffd9a0, moonIntensity: 1.05,
    ground: 0x171008, water: 0x3a2410, rain: false,
  },
  {
    id: 'acid', name: 'Acid Rain', desc: 'Something leaked in Sector 7. Green haze, toxic rain.',
    price: 0, premium: true, vcId: 'theme.acid',
    sky: 0x03130a, fog: 0x062b16, fogDensity: 0.007,
    ambient: 0x3a9160, ambientIntensity: 1.5, moon: 0x7dffa8, moonIntensity: 0.95,
    ground: 0x06120b, water: 0x0a3320, rain: true,
  },
  {
    id: 'sakura', name: 'Sakura Dusk', desc: 'Pink neon festival night under the blossom towers.',
    price: 0, premium: true, vcId: 'theme.sakura',
    sky: 0x170a1c, fog: 0x2b0f33, fogDensity: 0.0056,
    ambient: 0xa06cc0, ambientIntensity: 1.55, moon: 0xffc2e0, moonIntensity: 1.0,
    ground: 0x120a16, water: 0x2a1030, rain: false,
  },
]

export const DEFAULT_SKIN = SKINS[0]
export const DEFAULT_THEME = THEMES[0]

export function getSkin(id: string): Skin {
  return SKINS.find((s) => s.id === id) ?? DEFAULT_SKIN
}
export function getTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? DEFAULT_THEME
}

// ---------- ACHIEVEMENTS (PC-7) ----------
export interface Achievement {
  id: string
  name: string
  desc: string
  icon: string
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first-delivery', name: 'Special Courier',  desc: 'Complete your first Courier Run',        icon: '📦' },
  { id: 'delivery-10',    name: 'Harbor Workhorse', desc: 'Complete 10 Courier Runs',               icon: '🚚' },
  { id: 'first-race',     name: 'Gate Crasher',     desc: 'Finish a Harbor GP street race',         icon: '🏁' },
  { id: 'first-fare',     name: 'Meter Running',    desc: 'Complete a Taxi Fare',                   icon: '🚕' },
  { id: 'first-getaway',  name: 'Ghost Rider',      desc: 'Escape the Patrol in a Getaway contract', icon: '🚨' },
  { id: 'getaway-5',      name: 'Untouchable',      desc: 'Escape 5 pursuits in total',             icon: '👻' },
  { id: 'drift-500',      name: 'Smoke Show',       desc: 'Bank a single drift worth 500+',         icon: '💨' },
  { id: 'shard-12',       name: 'Shard Hunter',     desc: 'Collect 12 neon shards',                 icon: '💠' },
  { id: 'shard-24',       name: 'City Lights',      desc: 'Collect all 24 neon shards',             icon: '✨' },
  { id: 'level-5',        name: 'Harbor Legend',    desc: 'Reach level 5',                          icon: '⭐' },
  { id: 'buy-skin',       name: 'Fresh Paint',      desc: 'Buy a new car skin',                     icon: '🎨' },
  { id: 'buy-theme',      name: 'New Horizons',     desc: 'Buy a new city environment',             icon: '🌆' },
  { id: 'busted-3',       name: 'Frequent Flyer',   desc: 'Get busted by the Patrol 3 times',       icon: '🚔' },
  { id: 'rich-5k',        name: 'Five Grand',       desc: 'Hold $5,000 in cash at once',            icon: '💰' },
  { id: 'tour',           name: 'Sightseer',        desc: 'Visit every district of the city',       icon: '🗺️' },
]

// ---------- DISTRICTS (PC-7) ----------
// The city square spans -HALF..HALF (HALF = 205). Anything outside it is the
// free beach ring. EVERY district is open from the first minute (owner's call,
// 2026-10-10): the whole map is there to pick from, nothing is level-locked.
export interface District {
  id: string
  name: string
  desc: string
  minLevel: number
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export const DISTRICTS: District[] = [
  { id: 'downtown', name: 'Downtown Core', desc: 'The neon heart of the harbor',              minLevel: 1, minX: -82, maxX: 82, minZ: -82, maxZ: 82 },
  { id: 'north',    name: 'London Quarter', desc: 'Brick terraces, red phone boxes and the old clock tower', minLevel: 1, minX: -82, maxX: 82, minZ: -205, maxZ: -82 },
  { id: 'south',    name: 'Construction Yards', desc: 'Cranes, containers and stunt ramps',   minLevel: 1, minX: -82, maxX: 82, minZ: 82, maxZ: 205 },
  { id: 'west',     name: 'West End',      desc: 'London outskirts — terraced streets and markets', minLevel: 1, minX: -205, maxX: -82, minZ: -205, maxZ: 205 },
  { id: 'east',     name: 'Beijing Quarter', desc: 'Lantern-lit avenues and the golden pagoda', minLevel: 1, minX: 82, maxX: 205, minZ: -205, maxZ: 205 },
]

export function districtAt(x: number, z: number): District | null {
  if (Math.abs(x) > 205 || Math.abs(z) > 205) return null // beach ring — always free
  return DISTRICTS.find((d) => x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ) ?? null
}

