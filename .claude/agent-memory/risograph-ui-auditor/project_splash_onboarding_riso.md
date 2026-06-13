---
name: SplashScreen and OnboardingPage Riso Redesign
description: Full riso treatment applied to SplashScreen.tsx and OnboardingPage.tsx — patterns, decisions, and conventions used
type: project
---

SplashScreen and OnboardingPage received a full Risograph redesign on 2026-03-31.

**Why:** These are the first screens users see — they set the visual tone for the entire app. Previous versions used generic shadcn styles without riso character.

## SplashScreen decisions

- Card uses `card-riso riso-frame` classes for noise texture and registration-mark corner brackets
- Box-shadow uses dual-color riso offset: `5px 5px 0 rgba(11,114,104,0.18), -2px -2px 0 rgba(224,78,14,0.10)` — teal main offset + orange counter-offset
- `Loader2` spinner removed — replaced with three pulsing dots in orange/teal/violet using `animate-riso-pulse` with staggered `animationDelay`
- Status message rendered in `font-mono-ui` with a `dots[dotPhase]` counter (◆ / ◆◆ / ◆◆◆) cycling at 480ms intervals
- Title uses `font-display font-black riso-title` for mis-registration shadow effect
- Error state uses destructive color with a `surface-noise-flat` panel and colored offset shadow
- Riso strip (`var(--riso-strip)`) applied as a 3px top border accent on the card
- Background blobs (3 circles: teal, orange, violet) with `animate-blob-drift` variants + registration crosshairs SVGs + halftone cluster SVG in corner
- `animate-ink-in` on the card for entrance animation

## OnboardingPage decisions

- Step indicator: pill dots that grow/change color on active step (orange = current, teal = completed, background-3 = future)
- Engine selection cards: use `card-riso` / `card-riso-orange` class per card type; active state shows accent-colored border + background tint + `◆ SELECTED` mono label
- All action buttons converted to `btn-tactile` variants: "Apply & Continue" → `btn-tactile-teal`, "Open CrowForge" → `btn-tactile-orange`, "Skip" → `btn-tactile-outline`
- Form inputs styled with inline styles (riso border, noise background, focus state shifts border to teal + offset shadow) using `onFocus`/`onBlur` handlers — avoids global CSS conflicts
- Step 3 success icon: custom circular stamp — circle with teal border + dual offset shadow + `✓` character, replacing generic `CheckCircle2` from lucide
- Feature list in step 3: rendered as a bordered panel with `surface-noise`, section label, and per-row color dots matching accent palette
- Logo (`crowforgeIco`) wrapped in `riso-stamp-press` for hover interaction; displayed without any background circle
- Title uses `font-display font-black riso-title` in both step 1 and step 3
- Card: same dual-offset shadow pattern as SplashScreen, with `riso-frame` corner marks and `card-riso` noise

**How to apply:** When redesigning other modal/overlay/wizard screens, use this SplashScreen + OnboardingPage as the canonical pattern for centered card surfaces with riso treatment.
