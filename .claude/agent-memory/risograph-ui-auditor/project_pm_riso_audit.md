---
name: PM Module Riso Audit 2026-03-31
description: Full Risograph audit and enforcement pass on all PM and Issue Tracker views — key patterns, decisions, and tokens used
type: project
---

Full Risograph style enforcement applied to all PM and Issue Tracker views on 2026-03-31.

**Why:** User requested cohesive Risograph design across Management and Issue Tracker views to match the existing design language in ProjectsPage (which already had good riso bones).

**How to apply:** Use the patterns below as the reference standard for any future PM component work.

## Files changed
- src/index.css — Added `--color-background-2`, `--color-background-3`, `--color-border-strong` to @theme inline; added PM-specific animation keyframes (`riso-column-in`, `riso-card-in`, `row-tactile`, `pm-surface`)
- src/components/PM/ProjectCard.tsx — `card-riso surface-noise`, strong border, project-color offset shadow, hover translate(-1px,-1px)
- src/components/PM/TaskCard.tsx — `card-riso surface-noise`, `2px 2px 0 var(--riso-teal)` shadow, press-in mouseDown animation
- src/components/PM/MemberAvatar.tsx — Added border + 1px offset shadow to colored avatar
- src/components/PM/KanbanBoard.tsx — Filter buttons use `btn-tactile`, column headers use `surface-noise` + per-status riso shadow, droppable zones use `background-2` with dashed orange border on drag-over; column/card entrance animations
- src/components/PM/BacklogView.tsx — Filter buttons `btn-tactile`, table border uses riso-teal shadow, table header uses `background-3` with uppercase mono font, context menu uses `card` + `3px 3px 0` shadow, row transition cleaned up
- src/components/PM/SprintView.tsx — Sprint cards use `surface-noise` + status-colored riso shadow (orange=active, teal=completed), progress bar uses `accent-teal` fill + `background-3` track, status badges use color-mix, "New Sprint" button uses `btn-tactile-teal`, "Complete" uses `btn-tactile-teal`
- src/pages/ProjectDetailPage.tsx — Top bar uses `surface-noise background-2`, back/action buttons use `btn-tactile`, stat pills use `background-3` badge style, deadline warning uses color-mix, tabs use `background-3` rail, suggested task cards have riso offset shadows; wrapping div gets `pm-surface`
- src/pages/ProjectsPage.tsx — Dialog inputs get strong riso border + 1px shadow
- src/components/PM/IssueTrackerView.tsx — Filter toolbar uses `surface-noise background-2`, all filter buttons use `btn-tactile`, table header uses `background-3`, group headers use accent-orange project code, issue ID cells use accent-orange bold mono, row selection uses color-mix orange tint, bulk bar has riso-orange top shadow, inline dropdown uses riso card shadow
- src/pages/IssueTrackerPage.tsx — Header uses `surface-noise background-2` + font-display riso title, "Report Bug" button uses `btn-tactile-orange`, form inputs get riso border; page gets `pm-surface`

## Riso background graphics layer (added 2026-03-31)
Added full blob/crosshair/halftone background treatment to ProjectDetailPage and IssueTrackerPage, matching the SplashScreen/OnboardingPage canonical pattern.

Pattern used:
- Root div gets `position: relative`
- Background container: `position: absolute; inset: 0; zIndex: 0; overflow: hidden; pointer-events: none`
- 3 blobs with `animate-blob-drift` / `animate-blob-drift-b` / `animate-blob-drift-c`, `mixBlendMode: multiply`, opacity 0.06–0.08
- 2 SVG registration crosshairs (top-right teal rgba(11,114,104), bottom-left orange rgba(224,78,14))
- 1 SVG halftone dot cluster (orange dots for ProjectDetail at bottom-right; teal dots for IssueTracker at top-right)
- All flex sibling content divs get `position: relative; zIndex: 1` to stack above background
- Pages use `position: absolute` (not `fixed`) so blobs clip to `overflow: hidden` container, not viewport
- ProjectDetail: teal top-right + orange bottom-left + violet mid-right; halftone at bottom-right
- IssueTracker: orange top-left + teal bottom-right + violet mid-left; halftone at top-right (teal dots)

## Key design decisions
- `btn-tactile` / `btn-tactile-orange` / `btn-tactile-teal` — consistent button system for all PM actions (replaces shadcn Button)
- Column status shadows use per-status riso accent colors (orange for active, teal for resolved, red for rejected)
- Sprint cards: active=orange shadow, completed=teal shadow, planned=subtle dark shadow
- `surface-noise` used on all toolbar/header strips; `card-riso` on interactive cards
- Progress bars: squared `rounded-sm` rather than `rounded-full`, `background-3` track, `accent-teal` fill
- Issue tracker ID cells: `accent-orange` bold mono — gives print-register feeling
- All inline dropdowns share the riso card shadow (`3px 3px 0 rgba(20,16,10,0.18)`)
- `pm-surface` CSS class for subtle background blob glows on page containers
- `animate-column-in` + `animate-card-in` with stagger delays for kanban entrance
- `prefers-reduced-motion` block added to index.css covering all PM animations
