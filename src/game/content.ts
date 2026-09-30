// ============================================================
// NEON HARBOR — content catalog
// Skins (car paints), environment themes, economy constants.
// Premium = locked behind the Full Access Pass (monetization).
// ============================================================

export interface Skin {
  id: string
  name: string
  desc: string
  price: number // in-game cash; 0 = free starter
  usd: number // real-money quick-buy price; 0 = not sold separately
  premium: boolean // requires Full Access Pass
  legend?: boolean // Founder's Legend bundle exclusive (never sold separately)
  minLevel: number
  body: number // car paint color (hex)
  glow: number // underglow / trail color (hex)
  model?: string // Kenney car-kit model id (default sedan-sports)
}

export interface Theme {
  id: string
  name: string
  desc: string
  price: number
  usd: number // real-money quick-buy price; 0 = not sold separately
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
}

export const FULL_ACCESS_PRICE = '$14.99'
export const FOUNDER_LEGEND_PRICE = '$99.99'
export const GAME_VERSION = 'v0.15.3'
export const GAME_TITLE = 'NEON HARBOR'

// ---------- CAR SKINS ----------
// Price ladder (regional-friendly): $0.99 impulse entry → $1.99/$2.99 low →
// $4.99 standard premium → $9.99 flagship (most customization lives here) →
// Full Access $14.99 (everything) → Founder's Legend $99.99 (ultra tier).
// In-game cash prices reduced ~35% for faster progression.
export const SKINS: Skin[] = [
  { id: 'stock',    name: 'Harbor Gray',   desc: 'Factory fresh port-runner coupe.',        price: 0,    usd: 0,    premium: false, minLevel: 1, body: 0x8a93a6, glow: 0x22d3ee },
  { id: 'blue',     name: 'Midnight Blue', desc: 'Deep-sea metallic with cyan underglow.',  price: 300,  usd: 1.99, premium: false, minLevel: 1, body: 0x1d4ed8, glow: 0x38bdf8 },
  { id: 'amber',    name: 'Taxi Amber',    desc: 'Ride-share legend. Smells like hustle.',  price: 450,  usd: 0.99, premium: false, minLevel: 2, body: 0xf59e0b, glow: 0xfde047, model: 'taxi' },
  { id: 'white',    name: 'Rally White',   desc: 'Clean, loud, and gone before the echo.',  price: 600,  usd: 1.99, premium: false, minLevel: 2, body: 0xf1f5f9, glow: 0x4ade80, model: 'hatchback-sports' },
  { id: 'viper',    name: 'Viper Green',   desc: 'Toxic avenger of the dock district.',     price: 900,  usd: 2.99, premium: false, minLevel: 3, body: 0x16a34a, glow: 0xa3e635, model: 'suv' },
  { id: 'ghost',    name: 'Crimson Ghost', desc: 'The patrol hates this one.',              price: 0,    usd: 4.99, premium: true,  minLevel: 1, body: 0x9f1239, glow: 0xfb7185, model: 'race' },
  { id: 'royal',    name: 'Royal Violet',  desc: 'Harbor-night royalty.',                   price: 0,    usd: 4.99, premium: true,  minLevel: 1, body: 0x6d28d9, glow: 0xc084fc, model: 'suv-luxury' },
  { id: 'solar',    name: 'Solar Flare',   desc: 'Molten gold, zero subtlety.',             price: 0,    usd: 9.99, premium: true,  minLevel: 1, body: 0xd97706, glow: 0xfbbf24, model: 'race' },
  { id: 'oni',      name: 'Cyber Oni',     desc: 'Matte black, demon neon.',                price: 0,    usd: 9.99, premium: true,  minLevel: 1, body: 0x111114, glow: 0xff2d95, model: 'race' },
  { id: 'aurora',   name: 'Aurora Prime',  desc: "Legend-exclusive chasing-light paint. Never sold separately.", price: 0, usd: 0, premium: true, legend: true, minLevel: 1, body: 0x0ea5e9, glow: 0xa5f3fc, model: 'race' },
]

// ---------- ENVIRONMENT THEMES ----------
export const THEMES: Theme[] = [
  {
    id: 'midnight', name: 'Midnight Rain', desc: 'The classic. Neon reflections, warm rain.',
    price: 0, premium: false,
    sky: 0x070a18, fog: 0x0d1226, fogDensity: 0.0078,
    ambient: 0x41527a, ambientIntensity: 1.15, moon: 0x9cc0ff, moonIntensity: 0.85,
    ground: 0x0d1120, water: 0x0d2c40, rain: true,
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
    price: 800, usd: 4.99, premium: false,
    sky: 0x2a1608, fog: 0x58290a, fogDensity: 0.0065,
    ambient: 0xffb26b, ambientIntensity: 1.0, moon: 0xffd9a0, moonIntensity: 0.9,
    ground: 0x171008, water: 0x3a2410, rain: false,
  },
  {
    id: 'acid', name: 'Acid Rain', desc: 'Something leaked in Sector 7. Green haze, toxic rain.',
    price: 0, usd: 9.99, premium: true,
    sky: 0x03130a, fog: 0x062b16, fogDensity: 0.0088,
    ambient: 0x3a9160, ambientIntensity: 1.2, moon: 0x7dffa8, moonIntensity: 0.75,
    ground: 0x06120b, water: 0x0a3320, rain: true,
  },
  {
    id: 'sakura', name: 'Sakura Dusk', desc: 'Pink neon festival night under the blossom towers.',
    price: 0, usd: 9.99, premium: true,
    sky: 0x170a1c, fog: 0x2b0f33, fogDensity: 0.007,
    ambient: 0xa06cc0, ambientIntensity: 1.25, moon: 0xffc2e0, moonIntensity: 0.85,
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
// free beach ring. Downtown is open from level 1; outer districts gate on level.
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
  { id: 'north',    name: 'Harbor North',  desc: 'Warehouses, cranes and night shifts',      minLevel: 2, minX: -82, maxX: 82, minZ: -205, maxZ: -82 },
  { id: 'south',    name: 'Harbor South',  desc: 'Markets, food stalls and back alleys',     minLevel: 2, minX: -82, maxX: 82, minZ: 82, maxZ: 205 },
  { id: 'west',     name: 'West Docks',    desc: 'Container mazes and smuggler runs',        minLevel: 3, minX: -205, maxX: -82, minZ: -205, maxZ: 205 },
  { id: 'east',     name: 'East Neon',     desc: 'Towers, casinos and the rich side',        minLevel: 4, minX: 82, maxX: 205, minZ: -205, maxZ: 205 },
]

export function districtAt(x: number, z: number): District | null {
  if (Math.abs(x) > 205 || Math.abs(z) > 205) return null // beach ring — always free
  return DISTRICTS.find((d) => x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ) ?? null
}

