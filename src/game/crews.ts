// ============================================================
// NEON HARBOR — rival crews (district takeover)
// Every outer district is run by a crew. Beat its five challenges
// and the district is yours: it shows in your colours on the map
// and pays a Home Turf bonus on every contract finished there.
// Pure data + helpers; the engine owns the missions themselves.
// ============================================================

export type CrewMissionKind = 'delivery' | 'race' | 'taxi' | 'getaway'
export type CrewMod = 'rush' | 'fragile' | 'hot' | 'vip' | 'clean'

export interface CrewStep {
  title: string
  kind: CrewMissionKind
  mods: CrewMod[]
  /** What the player is told when the challenge starts. */
  brief: string
  /** Mia's line when it is won. */
  win: string
}

export interface Crew {
  /** District id from content.ts DISTRICTS. */
  district: string
  name: string
  boss: string
  /** Map colour while the crew still holds the district. */
  color: string
  /** Cash for taking the whole district. */
  takeoverCash: number
  steps: CrewStep[]
}

export const CREW_STEPS = 5
/** Contract pay bonus inside a district you have taken. */
export const HOME_TURF_BONUS = 0.2

export const CREWS: Crew[] = [
  {
    district: 'north',
    name: 'Clockwork Crew',
    boss: 'Big Ben',
    color: '#f59e0b',
    takeoverCash: 2000,
    steps: [
      { title: 'On the Clock', kind: 'delivery', mods: ['rush'], brief: 'The Clockwork Crew time everything. Run their parcel faster than they can.', win: 'Mia: "They checked their watches twice. Good start."' },
      { title: 'Tea Run', kind: 'taxi', mods: ['vip'], brief: 'Their accountant needs a lift. Not a scratch on the car.', win: 'Mia: "Smooth. He tipped — that never happens."' },
      { title: 'Tower Circuit', kind: 'race', mods: [], brief: 'Eight gates round the clock tower. Their best driver set the time.', win: 'Mia: "You just beat their lap. The whole terrace saw it."' },
      { title: 'Fine China', kind: 'delivery', mods: ['fragile', 'rush'], brief: 'Antique clock parts. Fragile, and late is not an option.', win: 'Mia: "Every piece intact. Big Ben is asking who you are."' },
      { title: 'Stop the Clock', kind: 'getaway', mods: [], brief: 'Big Ben called the Patrol on you himself. Lose them and London is yours.', win: 'Mia: "He handed over the keys to the quarter. London Quarter is ours."' },
    ],
  },
  {
    district: 'south',
    name: 'Steel Rats',
    boss: 'Rivet',
    color: '#94a3b8',
    takeoverCash: 2000,
    steps: [
      { title: 'Hard Hat Delivery', kind: 'delivery', mods: [], brief: 'The Steel Rats want to see if you can find your way round the yards.', win: 'Mia: "Welcome to the Yards. They are watching now."' },
      { title: 'Crane Dash', kind: 'race', mods: ['hot'], brief: 'Race the yard gates with the Patrol already awake.', win: 'Mia: "Dust everywhere, and you in front of it."' },
      { title: 'Foreman on Board', kind: 'taxi', mods: ['rush'], brief: 'Their foreman is late for a pour. Concrete does not wait.', win: 'Mia: "On time. The foreman owes you one."' },
      { title: 'Glass Panels', kind: 'delivery', mods: ['fragile', 'clean'], brief: 'Tower glass. One crash and it is all sand again.', win: 'Mia: "Not a crack. Rivet has stopped laughing."' },
      { title: 'Break the Fence', kind: 'getaway', mods: [], brief: 'Rivet tipped off the Patrol. Shake them and the Yards are yours.', win: 'Mia: "The Steel Rats are repainting their helmets in your colours."' },
    ],
  },
  {
    district: 'west',
    name: 'Market Kings',
    boss: 'Duchess',
    color: '#a78bfa',
    takeoverCash: 2500,
    steps: [
      { title: 'Stall Stock', kind: 'delivery', mods: ['rush'], brief: 'The market opens in minutes. The Kings want their stock on the stalls.', win: 'Mia: "Stalls stocked. The Duchess noticed."' },
      { title: 'Royal Fare', kind: 'taxi', mods: ['vip', 'rush'], brief: 'The Duchess herself. Fast, and she must not spill her tea.', win: 'Mia: "She said \'acceptable\'. From her that is a medal."' },
      { title: 'Terrace Sprint', kind: 'race', mods: [], brief: 'Their street racers know every terrace. Learn them faster.', win: 'Mia: "West End is talking about one car tonight. Yours."' },
      { title: 'Hot Goods', kind: 'delivery', mods: ['hot', 'fragile'], brief: 'Hot cargo, and it breaks. The Patrol is already looking.', win: 'Mia: "Delivered hot and whole. The Kings are nervous."' },
      { title: 'Crown the Street', kind: 'race', mods: ['hot', 'rush'], brief: 'Final race for the crown: tight clock, Patrol awake.', win: 'Mia: "The Duchess curtsied. West End is ours."' },
    ],
  },
  {
    district: 'east',
    name: 'Golden Dragons',
    boss: 'Lady Jin',
    color: '#f43f5e',
    takeoverCash: 3000,
    steps: [
      { title: 'Lantern Run', kind: 'delivery', mods: ['clean'], brief: 'Carry the festival lanterns down the avenue without a mark on the car.', win: 'Mia: "Lanterns lit. The Dragons bowed — a little."' },
      { title: 'Pagoda Circuit', kind: 'race', mods: ['rush'], brief: 'Eight gates round the golden pagoda, on a short clock.', win: 'Mia: "They have not lost that circuit in years."' },
      { title: 'Honoured Guest', kind: 'taxi', mods: ['vip'], brief: 'Lady Jin\'s guest rides with you. A single crash is an insult.', win: 'Mia: "The guest asked for you by name next time."' },
      { title: 'Jade Shipment', kind: 'delivery', mods: ['fragile', 'hot', 'rush'], brief: 'Jade: fragile, hot, and due now. The hardest run in the harbor.', win: 'Mia: "Every piece of jade. Lady Jin wants to meet."' },
      { title: 'Dragon\'s Tail', kind: 'getaway', mods: [], brief: 'Lady Jin sent the whole Patrol. Escape and the Quarter bows to you.', win: 'Mia: "The lanterns are your colour tonight. Beijing Quarter is ours."' },
    ],
  },
]

export function crewFor(districtId: string): Crew | undefined {
  return CREWS.find((c) => c.district === districtId)
}

/** Steps beaten in a district (0..5). */
export function crewRep(crews: Record<string, number> | undefined, districtId: string): number {
  return Math.max(0, Math.min(CREW_STEPS, crews?.[districtId] ?? 0))
}

export function districtOwned(crews: Record<string, number> | undefined, districtId: string): boolean {
  return crewRep(crews, districtId) >= CREW_STEPS
}

export function districtsOwned(crews: Record<string, number> | undefined): number {
  return CREWS.filter((c) => districtOwned(crews, c.district)).length
}
