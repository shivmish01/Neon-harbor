# NEON HARBOR — Mobile Test SOP (Standard Operating Procedure)

**Canonical test URL:** https://shivmish01.github.io/Neon-harbor/
**Device:** phone (Android Chrome / iOS Safari), landscape orientation.

---

## STEP 0 — Prove you are on the latest build (do this FIRST, every time)

1. Open the URL, enter the game.
2. Look at the **bottom-left corner**: a tiny line reads `v1.5.0 · <hash>`.
3. Compare `<hash>` with recent commits on GitHub (`git log --oneline -3` or the repo page). The stamp is baked in at build time, so it matches the commit the build was made **from** — it will be one of the 2–3 most recent commits (release commits only add build output).
4. **Hash doesn't match?** Your phone is showing a stale cached page. Fix: close the tab → browser Settings → clear site data (or open the URL with `?v=<hash>` appended) → reload.
5. The pause menu (⏸ top center) also shows the full build stamp + build time at the bottom.

> Never report "feature missing" before Step 0 passes. 90% of "I can't see the change" is a stale cache.

---

## Feature checklist — every feature, how to trigger it, what you must see

### A. First-Time User Experience (FTUE) — hand-guided, zero reading
| # | Feature | How to trigger on mobile | Expected |
|---|---------|--------------------------|----------|
| A1 | Interactive guide hand | Fresh install (or Pause → **REPLAY TUTORIAL**) | Cartoon hand animates over real controls, tiny word-chips only |
| A2 | Step 1: joystick | Hand pushes the left joystick up | Push up → car drives, chip turns "✓ GO!" |
| A3 | Step 2: swipe steer | Hand swipes the right half of screen | Swipe while driving → car turns with your finger |
| A4 | Step 3: nitro | Hand taps the ⚡ button | Tap ⚡ → boost flames, chip turns "✓ BOOM!" |
| A5 | Step 4: objective | Hand points at the glowing garage beam | Drive into the beam → "✓ THAT'S THE SPOT" |
| A6 | Replay anytime | ⏸ Pause → REPLAY TUTORIAL | Whole flow restarts; no reinstall needed |

### B. Driving & controls
| # | Feature | How to trigger | Expected |
|---|---------|----------------|----------|
| B1 | Joystick drive | Hold joystick up | Car accelerates; release = coast |
| B2 | Free driving | Drive anywhere on open road | **Car never stops or gets blocked on open road** — no tolls, no popups, no text walls |
| B3 | Swipe steering (CoD-style) | Fast flick right/left while driving | Instant sharp turn-in; finger stops → car straightens in ~0.15 s |
| B4 | Crawl steering | Nearly stopped + joystick up + swipe | Car still rotates visibly (GTA-style) |
| B5 | Sand driving | Drive onto the beach ring | ~88 km/h cruising on sand, no more wet-cement feel |
| B6 | Scrape = slide | Graze a pole/wall at low speed | Car slides along, keeps momentum (only hard crashes bounce) |
| B7 | Nitro | Hold ⚡ | Flames + speed; refills by drifting |
| B8 | Drift | Hold ◎ while turning | Slide + score; refills nitro |
| B9 | Horn | Tap ))) button | Pedestrians dive out of the way |
| B10 | Brake/reverse | Hold ■ pedal | Brake, then reverse |
| B11 | Stuck safety net | Wedge the car against a wall ~7 s | Auto-respawn on road; small RESET button also appears — no banner, no interruption |

### C. Damage & police (the simulator layer)
| # | Feature | How to trigger | Expected |
|---|---------|----------------|----------|
| C1 | Crash damage | Hit pillars/walls hard | Speed drops, smoke pours, paint fades with damage |
| C2 | WRECKED | Keep crashing to 0% | Car explodes → game-over screen → restart |
| C3 | Pedestrian hits | Hit a person | "Oh no!" / "Don't kill me!" scream, heat +1★ |
| C4 | Police chase | Commit offenses (hits, hard crashes) | PATROL stars fill, cruisers hunt you, at night a spotlight tracks your car |
| C5 | Action mode hint | While chased | Info near the pause button area tells you to escape — text sits under the minimap, never blocks the driving view |
| C6 | Busted | Let a cruiser pin you | Busted flash → fine → chase ends |

### D. Map & navigation (AMap / Google style)
| # | Feature | How to trigger | Expected |
|---|---------|----------------|----------|
| D1 | Minimap | Top-right corner | Bright AMap style: blue water, sand ring, white roads, blue route line |
| D2 | Big city map | **Tap the minimap itself** | Right-side panel opens (CoD pattern), live-updating: your dot, route, patrols, district names on white pills |
| D3 | Close big map | Tap ✕ on the panel | Back to driving; game never paused |
| D4 | Route guidance | Take a job / free roam | Google-blue line to objective (or garage), distance pill at destination |
| D5 | Districts | Open big map | LONDON QUARTER, DOWNTOWN CORE, WEST END 🔒Lv3, BEIJING QUARTER 🔒Lv4, CONSTRUCTION YARDS labeled |

### E. World content
| # | Feature | How to trigger | Expected |
|---|---------|----------------|----------|
| E1 | Jobs | Drive into garage beam → tap E | Job board: Courier / Taxi / Harbor GP race / Getaway |
| E2 | Busy beach | Drive the sand ring | Sunbathers, couples, beach-ball games, campfire guitar circles, food stalls, seagulls |
| E3 | Bridge & island | Drive south across the sand | Neon-railed bridge over the sea → lighthouse island |
| E4 | London Quarter | Drive to the marked district | Clock tower, red phone booths, double-decker bus |
| E5 | Beijing Quarter | Drive to the marked district | Pagoda, lanterns |
| E6 | Construction Yards | Drive to the marked district | Cranes, barriers, stunt yard (ramps = rooftop jumps) |
| E7 | Traffic rhythm | Drive downtown | Normal flow most of the time; **rush-hour jams** and **accident scenes with crowds** are the ONLY road blocks |
| E8 | Day/night cycle | Pause → ENVIRONMENT CYCLE: ON | Time passes; at night headlights light the road (not blinding) |

### F. Progression & economy
| # | Feature | How to trigger | Expected |
|---|---------|----------------|----------|
| F1 | Garage shop | Pause → GARAGE SHOP | Buy upgrades (engine/nitro/tires/armor/suspension/horn) with earned cash |
| F2 | Other cars | Shop → car skins | Different models: taxi, hatchback, SUV, race cars — owned cars kept |
| F3 | Premium (VCoin) | Shop → premium items | Premium skins via vplay.gg VCoin purchase flow |
| F4 | Repair | After damage, visit garage | Car restored (refine between runs) |
| F5 | Levels & trophies | Earn XP from jobs/drift/shards | Level-ups unlock districts; trophies pay bonuses |
| F6 | Save | Play, then reload the page | Progress persists; EXPORT/IMPORT SAVE in pause menu |

### G. Platform separation
| # | Feature | How to trigger | Expected |
|---|---------|----------------|----------|
| G1 | Mobile text | Play on phone | All hints reference touch (joystick/swipe/tap), ZERO keyboard mentions |
| G2 | Desktop text | Play on laptop | Hints show keys (W/A/S/D, E, H, M…) |
| G3 | Controls switch | Pause → CONTROLS | Joystick scheme ↔ classic buttons scheme |

---

## Bug-report format (so issues are actionable)

1. Build line from the corner: `v… · hash`
2. Feature ID from this SOP (e.g. "D2")
3. What you did (3 words), what you saw, what you expected
4. Screenshot or screen recording
