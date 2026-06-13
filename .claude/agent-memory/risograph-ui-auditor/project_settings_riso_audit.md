---
name: SettingsPage Riso Redesign 2026-03-31
description: Full Risograph audit and enforcement pass on SettingsPage.tsx — all five tabs restyled
type: project
---

SettingsPage fully restyled on 2026-03-31 with Risograph design language.

**Why:** User requested full Riso redesign matching the pattern established in PM module and OnboardingPage.

**How to apply:** Reference these patterns when touching SettingsPage or building similarly structured tabbed settings pages.

## Tab navigation pattern
- Each tab button: `font-mono-ui`, `1.5px solid transparent` default border, active state gets `1.5px solid color-mix(orange 30%, transparent)` + `2px 2px 0 var(--riso-orange)` box-shadow + warm orange background tint
- Colored dot (1.5×1.5 rounded-full) per tab using its accent color

## Section heading pattern
- Colored left-bar accent: `w-2 h-5 rounded-sm` with section accent color
- `font-display font-bold riso-title` heading at 1.1rem

## Card pattern for grouped settings
- `card-riso` + color variant (`card-riso-orange`, `card-riso-teal`, `card-riso-violet`) + `rounded-lg border surface-noise`
- `borderColor: var(--border-strong)` inline style
- Interior sub-labels use `riso-section-label` class

## Input pattern (all form inputs)
- `border: '1.5px solid var(--border-strong)'` inline style (not Tailwind border class)
- `bg-background`, `outline-none`, `px-3 py-1.5`, `text-sm`
- URL/path inputs use `font-mono-ui`, regular text inputs use `font-sans`
- Selects follow same treatment

## Button pattern
- Primary action: `btn-tactile btn-tactile-orange` (save, submit)
- Secondary: `btn-tactile btn-tactile-teal` (add, reload)
- Destructive: inline style `background: var(--destructive)` on `btn-tactile`
- Outline/ghost: `btn-tactile btn-tactile-outline`
- Download: `btn-tactile btn-tactile-dark`

## AI section layout
- Two-column grid: `340px 1fr`
- Left: engine config card + PC specs card
- Right: model gallery with `card-riso` per model, `tag-riso`/`tag-riso-teal`/`tag-riso-violet` for metadata chips
- Tag filter uses `btn-tactile` with `btn-tactile-orange` for active state

## Preferences section layout
- Two-column grid: `grid-cols-2`
- Theme switcher: 2px border active/inactive, `3px 3px 0 var(--riso-orange)` shadow on selected
- Avatar grid: same selected-state treatment with orange border + riso-orange shadow
- Plugins: `card-riso rounded-lg border surface-noise` per plugin row
- Data management rows: `surface-noise`, `background-2`, `border-strong` inline

## PM / Team & Workflow section
- Team member rows: `surface-noise`, `background-2`, `border-strong`
- Workflow columns: column headers use `riso-section-label` with per-column accent color
- Status/severity rows: `surface-noise`, `background-2`, `border-strong`
- "Add X" inputs: `1.5px dashed var(--border-strong)` border

## News Feeds section
- Feed library card: `card-riso rounded-lg border surface-noise`
- Add custom feed card: `card-riso card-riso-orange`
- My Feeds list: `card-riso rounded-md border surface-noise` per item
- Toggle/delete buttons: `btn-tactile btn-tactile-outline` with icon color overrides

## About section
- Version info: inline `riso-section-label` + `tag-riso font-mono-ui` badges
- Developer card: `card-riso card-riso-orange riso-frame`; LT avatar uses orange accent ring + riso-orange shadow
- Claude card: `card-riso card-riso-violet`; link button is `btn-tactile btn-tactile-violet`
