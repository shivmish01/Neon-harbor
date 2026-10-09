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
  tows: number // wreck tows paid (first one ever is free)
  repairs: number // garage repairs paid (first one ever is free)
  cred: number // lifetime Street Cred banked (Phase 1)
}

/** Night Shift (Phase 1, step 4): 3 small goals per set. They never expire —
    a 5-minute visit still finishes something. Completing a set pays
    cash 250×level + 500 XP and posts a fresh set. */
export interface ShiftGoal {
  id: string
  label: string
  target: number
  progress: number
  done: boolean
}
export interface NightShift {
  goals: ShiftGoal[]
  completedCount: number // sets finished (drives shift.complete.* milestones)
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
  upgrades: Record<'engine' | 'nitro' | 'tires' | 'armor' | 'suspension' | 'horn', number> // bought performance levels (0-3)
  controls: 'joystick' | 'buttons' // touch control scheme
  /** body damage 0-100 — crashes cost, the garage repairs. NEVER slows the car. */
  damage: number
  /** vplay.gg milestone ids already reported — each is sent at most once */
  reportedMilestones: string[]
  stats: Stats
  shift: NightShift
  /** Free-roam cred XP anti-farm window. Saved (not in memory) and timed with
      real clock ms, so reloading the page can't reset the 400 XP / 10 min cap. */
  credCap: { windowStartMs: number; xpUsed: number }
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
    upgrades: { engine: 0, nitro: 0, tires: 0, armor: 0, suspension: 0, horn: 0 },
    controls: 'joystick',
    damage: 0,
    reportedMilestones: [],
    stats: { deliveries: 0, races: 0, bestRace: 0, bestDrift: 0, busts: 0, fares: 0, getaways: 0, tows: 0, repairs: 0, cred: 0 },
    shift: { goals: [], completedCount: 0 },
    credCap: { windowStartMs: 0, xpUsed: 0 },
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
      upgrades: { ...base.upgrades, ...(parsed.upgrades ?? {}) },
      landmarks: parsed.landmarks ?? [],
      legend: parsed.legend ?? false,
      reportedMilestones: parsed.reportedMilestones ?? [],
      shift: {
        completedCount: parsed.shift?.completedCount ?? 0,
        goals: (parsed.shift?.goals ?? []).map((g) => ({ ...g })),
      },
      credCap: {
        windowStartMs: parsed.credCap?.windowStartMs ?? 0,
        xpUsed: parsed.credCap?.xpUsed ?? 0,
      },
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

/** XP needed to go from `level` to `level + 1`.
    Phase 1 curve: 600 + 300 × level (was level × 1000 — L10 needed 45,000 XP
    and was never reached; now ~19,500). Migration-safe by construction:
    grantXp only ever ADDS levels, so no existing save can drop a level. */
export function xpForLevel(level: number): number {
  return 600 + 300 * level
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
