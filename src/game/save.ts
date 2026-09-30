// ============================================================
// NEON HARBOR — save system (localStorage)
// Holds cash, XP, unlocks, loadout, early-access purchase flag.
// ============================================================

export interface Stats {
  deliveries: number
  races: number
  bestRace: number // seconds, 0 = none
  bestDrift: number
  busts: number
  fares: number // taxi passengers delivered
  getaways: number // patrol pursuits escaped
}

export interface SaveData {
  cash: number
  xp: number
  level: number
  shards: string[] // collected shard ids
  owned: string[] // owned shop item ids (skins + themes)
  skin: string
  theme: string
  fullAccess: boolean // owns the Full Access Pass (monetization flag)
  legend: boolean // owns the Founder's Legend bundle ($99.99 ultra tier)
  muted: boolean
  tutorialDone: boolean // first-time onboarding finished (or skipped)
  autoCycle: boolean // environment rotates through owned themes on a timer
  achievements: string[] // unlocked achievement ids
  districts: string[] // districts the player has entered at least once
  tollsPaid: string[] // districts unlocked early by paying the border toll
  controls: 'joystick' | 'buttons' // touch control scheme
  stats: Stats
}

const KEY = 'neon-harbor-save-v1'

export function defaultSave(): SaveData {
  return {
    cash: 250,
    xp: 0,
    level: 1,
    shards: [],
    owned: ['stock', 'midnight', 'day'],
    skin: 'stock',
    theme: 'midnight',
    fullAccess: false,
    legend: false,
    muted: false,
    tutorialDone: false,
    autoCycle: false,
    achievements: [],
    districts: [],
    tollsPaid: [],
    controls: 'joystick',
    stats: { deliveries: 0, races: 0, bestRace: 0, bestDrift: 0, busts: 0, fares: 0, getaways: 0 },
  }
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return defaultSave()
    const parsed = JSON.parse(raw) as Partial<SaveData>
    const base = defaultSave()
    return {
      ...base,
      ...parsed,
      stats: { ...base.stats, ...(parsed.stats ?? {}) },
      shards: [...new Set(parsed.shards ?? [])],
      owned: parsed.owned ?? base.owned,
      tollsPaid: parsed.tollsPaid ?? [],
      legend: parsed.legend ?? false,
    }
  } catch {
    return defaultSave()
  }
}

export function persistSave(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch {
    // storage unavailable (private mode etc.) — play session-only
  }
}

/** XP needed to go from `level` to `level + 1`. */
export function xpForLevel(level: number): number {
  return level * 1000
}

/** Add XP, handle level-ups. Returns how many levels gained. */
export function grantXp(save: SaveData, amount: number): number {
  save.xp += amount
  let ups = 0
  while (save.xp >= xpForLevel(save.level)) {
    save.xp -= xpForLevel(save.level)
    save.level += 1
    ups += 1
  }
  return ups
}
