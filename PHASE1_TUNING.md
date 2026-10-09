# Neon Harbor — Phase 1 tuning measurement (step 5)

Method: scripted self-driving bot in the live browser build, fresh save
(localStorage cleared), FTUE skipped with the designed T-skip at 20 s
(impatient-player path), 30 s sampling. Several bot generations were run;
the two representative ends of the spectrum are reported honestly.

## Measured rates (exact, from live runs)

| Metric | Measured |
|---|---|
| Delivery payout | $439–750 (+150 XP) |
| Taxi payout | $593–800 (+180 XP) |
| Race payout | ~$700–900 (+320 XP) |
| Getaway payout | $716–1,100 (+280 XP) |
| Cred banked on contract | 1:1 XP, +1% payout per 20 cred (cap +50%) |
| Free-roam cred | 1:2 XP, hard cap 400 XP / 10 min (engaged in run 1 ✓) |
| Level curve | 600 + 300×L → L1→2 = 900 XP, L2→3 = 1,200 XP |
| Shift set bonus | 250×level cash + 500 XP |

## Session outcomes

- **Competent bot** (grid-routed, 72 km/h cruise): 7 jobs in 5 min
  (4 deliveries, 2 taxi, 1 getaway), 603 XP at 5:00 → ~1,200 XP/10 min pace.
- **Cautious/crash-prone bot** (45 km/h cruise): 1 job, 185 XP, bankrupt at
  $14 after 7 tows + 5 repairs. This is a *bad-driver floor*, not the median.

## Projection vs targets (from measured rates)

- 5 jobs / 10 min ≈ 1,100 XP + Night Shift completion 500 XP + shards ~120 XP
  + free-roam cred (400 cap) ≈ **1,700–2,100 XP ≈ 1.8–2.2 level-ups**.
  Claude's target "≈2 level-ups in the first 10 minutes" → **MET** for average play.
- First Night Shift set: goals completed organically in both long runs
  (jumps3 finished in each); projected first-set finish ≈ **12–15 min** → target **MET**.

## Findings for Claude to rule on (NOT changed unilaterally)

1. **Crash economy is brutal for bad drivers.** Worst-case run: 7 tows
   ($150 each after the free first) + 5 repairs ($293–379 each) → bankrupt.
   Traffic deals full crash damage to the player even when the player is
   slow/stationary (2–8 dmg hits logged at 24–45 km/h on open road).
   The design said "repairs cost less", but that was NOT in the approved
   5-step scope — repair is still $4/point. Recommend a ruling: repair
   ~$2–3/point and/or a reduced damage share for traffic-vs-player impacts.
2. Verified working as designed: first-chase ★1 cap, First Night 60% damage
   cap, free first tow, free first repair, 400 XP/10 min anti-farm cap,
   `cred.x3` milestone fires exactly once into `reportedMilestones`.

## Milestones added in step 5

`cred.x3`, `cred.x5` (chain step-ups), `heat.payout3` (contract done at ★3+
peak), `shift.complete.1/5/20` (Night Shift sets), `modifier.fragile.clean`
(fragile contract, zero crashes). All fire through the new `onMilestone`
engine hook and dedupe per save via `reportMilestone`.
