// ============================================================
// NEON HARBOR — save system (localStorage)
// Holds cash, XP, unlocks, loadout. localStorage is the offline
// copy; vplay.gg owns premium entitlements (VCoins live there).
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
  owned: string[] // owned shop item ids (skins + themes, cash-bought or free)
  skin: string
  theme: string
  /** Legacy Early Access demo flags. No longer grant anything; kept only so
      old saves load. Migration keeps whatever items were locally owned. */
  fullAccess: boolean
  legend: boolean
  muted: boolean
  tutorialDone: boolean // first-time onboarding finished (or skipped)
  autoCycle: boolean // environment rotates through owned themes on a timer
  achievements: string[] // unlocked achievement ids
  districts: string[] // districts the player has entered at least once
  landmarks: string[] // discovered landmark names (persisted so reloads don't re-pay)
  controls: 'joystick' | 'buttons' // touch control scheme
  /** vplay.gg milestone ids already reported — each is sent at most once */
  reportedMilestones: string[]
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
    landmarks: [],
    controls: 'joystick',
    reportedMilestones: [],
    stats: { deliveries: 0, races: 0, bestRace: 0, bestDrift: 0, busts: 0, fares: 0, getaways: 0 },
  }
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return defaultSave()
    const parsed = JSON.parse(raw) as Partial<SaveData>
    const base = defaultSave()
    const merged: SaveData = {
      ...base,
      ...parsed,
      stats: { ...base.stats, ...(parsed.stats ?? {}) },
      shards: [...new Set(parsed.shards ?? [])],
      owned: parsed.owned ?? base.owned,
      landmarks: parsed.landmarks ?? [],
      legend: parsed.legend ?? false,
      reportedMilestones: parsed.reportedMilestones ?? [],
    }
    // Legacy Early Access demo: fullAccess/legend granted everything locally.
    // Keep whatever items the player already owned (it was a free demo), but
    // the flags themselves no longer unlock anything new.
    if (parsed.fullAccess) {
      merged.fullAccess = false
      const legacy = ['blue', 'amber', 'white', 'viper', 'golden']
      for (const id of legacy) if (!merged.owned.includes(id)) merged.owned.push(id)
    }
    merged.legend = false
    if (parsed.legend && !merged.owned.includes('aurora')) {
      // Aurora Prime is now earned in-game; old legend flag doesn't grant it
    }
    return merged
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
