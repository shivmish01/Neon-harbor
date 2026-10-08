# VPlay mock-host evidence — Neon Harbor

Run: 2026-10-08, dev build on localhost:5199, host = `public/vplay-host-mock.html`
(now with scenario toggles: signed out / silent host / cloud save ahead / pass.harbor only).
`←` = game → host, `→` = host → game, `★/⚙/✕` = host annotations. Loading-progress
replies omitted for readability.

## 1. VCoin purchase (success)
```
← req purchase {itemId:"skin.viper"}                       (price ◈400, balance 5000)
→ EVENT entitlements (purchase)
→ res ok {"status":"purchased","entitlements":["skin.viper"],"vcoins":4600}
← req saveCloud {… "owned":["stock","midnight","day"], skin:"stock" …}
```
Balance dropped 5000 → 4600; entitlement event pushed before the response; cloud save followed.

## 2. Purchase cancelled by player
```
← req purchase {itemId:"skin.blue"}
→ res ok {"status":"cancelled"}
```
No entitlement event, no balance change.

## 3. Insufficient VCoins
```
← req purchase {itemId:"skin.blue"}                        (mock: force insufficient)
→ res ok {"status":"insufficient","message":"Not enough VCoins"}
```

## 4. Signed-out player
```
→ res ok {"player":{"signedIn":false},"vcoins":4600,"items":[…],"entitlements":["skin.viper"],"save":null}
```
Game boots normally to title screen; shop gates VCoin purchases behind sign-in.

## 5. Host silent → 6s fallback to standalone
```
← req init {gameId:"neon-harbor",sdkVersion:1}
✕ silent host — ignoring request (game must fall back)
```
No reply sent. After INIT_TIMEOUT_MS (6s) the game fell back to standalone and the
title screen stayed fully usable (ENTER THE HARBOR present and clickable).

## 6. Cloud save ahead of local
```
⚙ cloud save armed (level 9 / $99,999) — applies to next init
→ res ok {… "save":{"cash":99999,"xp":400,"level":9,…,"tutorialDone":true}}
← req milestone {"id":"district.core"}        ← new district from merged save, sent once
← req milestone {"id":"ach.rich-5k"}          ← achievement unlocked by merged cash, sent once
```
Game merged: HUD shows Level 9, $100,249 (cloud won over local level 2 / $1,684).

## 7. Harbor Pass with ONLY pass.harbor in entitlements
```
→ res ok {… "entitlements":["pass.harbor"] …}   (individual premium items owned:false)
```
Game shows "🔓 HARBOR PASS owned — all premium content unlocked"; every premium
car (Ghost/Royal/Solar/Oni) and theme shows EQUIP instead of a ◈ price.

## 8. Milestones sent exactly once
Same achievement committed 3× in a row (forced via dev hook `__nh.hooks.commit()`):
```
← req milestone {"id":"ach.first-delivery"}
★ milestone: ach.first-delivery
→ res ok null
```
One request total. The game dedupes per save (`reportedMilestones`), and the mock
dedupes display (`★` prints on first receipt only) — a resend would still be visible
as a second `← req milestone` line. None appeared.
