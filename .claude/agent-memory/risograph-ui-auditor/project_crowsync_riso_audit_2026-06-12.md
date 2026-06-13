---
name: crowsync-riso-audit-2026-06-12
description: Full Risograph audit and enforcement pass on CrowSync UI — dark-industrial base, adapted riso tokens, press-in buttons, riso card surfaces, micro-animations
metadata:
  type: project
---

# CrowSync Risograph Audit — 2026-06-12

CrowSync is a dark-industrial SVN-style file sync tool (not CrowForge). Its palette is near-black surfaces with neon accents (orange #FF6B35, teal #00D4AA, blue #5B8DEF). Risograph adaptations must work ON DARK — offset shadows use neon accent colors, not black.

## Token strategy
- `--shadow-riso-sm/md/lg`: offset with `--color-accent` (orange)
- `--shadow-riso-sm-teal/md-teal`: offset with `--color-sync` (for success/confirm contexts)
- `--shadow-riso-md-dark/lg-dark`: offset with near-black `#080809` (for dialogs on dark backgrounds)
- `--border-riso`: `1.5px solid var(--color-border-active)` (slightly lighter than base border)
- `.btn-riso` base class + `.btn-riso-primary`, `.btn-riso-secondary`, `.btn-riso-danger` variants
- `.card-riso`: bold border + dark offset shadow + surface-2 background
- `.input-riso`: border + focus triggers accent border + 2px accent shadow
- `.halftone-accent`: decorative dot pattern overlay for dialog headers

## CSS classes added to `src/index.css`
- `.btn-riso`, `.btn-riso-primary`, `.btn-riso-secondary`, `.btn-riso-danger` — press-in at hover/active
- `.card-riso` — bold border + dark offset shadow
- `.input-riso` — riso focus state
- `.animate-riso-fade-up`, `.animate-riso-scale-in`, `.animate-riso-slide-right`, `.animate-riso-pulse`
- `.log-entry` — stagger-able entrance
- `.halftone-accent` — decorative header dot pattern
- `@media (prefers-reduced-motion: reduce)` — disables all animations, removes transform presses

## Files changed
- `src/index.css` — added all riso tokens + utility classes
- `src/App.tsx` — setup + settings screens: input-riso, btn-riso, card-riso, animate-riso-fade-up, textShadow on CS wordmark
- `src/pages/SyncPage.tsx` — PUSH/PULL/INIT topbar buttons: btn-riso-primary/secondary; empty state btn-riso-primary; "Select a project" uppercase mono
- `src/components/CrowSync/ProjectPanel.tsx` — New Project modal: card-riso + animate-riso-scale-in + halftone-accent header; buttons btn-riso; inputs input-riso; border-border-active on panel
- `src/components/CrowSync/ActivityFeed.tsx` — LogRow: colored border-l accent per action type; LIVE badge animate-riso-pulse; log count badge with riso shadow; border-border-active; "No activity" uppercase mono
- `src/components/CrowSync/FileDetail.tsx` — empty state uppercase mono; action buttons btn-riso; info labels uppercase mono tracking-widest; border-border-active on panel + header
- `src/components/CrowSync/ConflictDialog.tsx` — card-riso + animate-riso-scale-in; halftone danger header; buttons btn-riso
- `src/components/CrowSync/InitProjectDialog.tsx` — card-riso + animate-riso-scale-in; halftone accent header; inputs input-riso; Browse btn-riso-secondary; all footer buttons btn-riso; confirm stats box riso-sm-teal shadow
- `src/components/CrowSync/ToastContainer.tsx` — per-type offset shadow (danger/sync/pull); border-[1.5px]; hover press-in translate
- `src/components/CrowSync/FileTree.tsx` — context menu: border-border-active + riso-md-dark shadow + animate-riso-scale-in; Delete item text-danger with danger hover bg

## What was NOT changed (by design)
- Color palette values — kept existing neon accents; did not introduce cream/warm paper tones (incompatible with dark-industrial theme)
- Logic, event handlers, props, aria/accessibility attributes
- FileTree row-level styling (minimal, acceptable as-is for dense file list)
- SyncStatus component (minimal status indicator, good as-is)

## Pending recommendations
- Consider adding a subtle grain texture to sidebar/panel backgrounds via SVG filter (CSS `url(#noise)`) for deeper riso feel
- PULL button uses inline `style` overrides for teal-variant shadow — could be extracted to a `.btn-riso-pull` variant class if needed
- Letter-spacing on project sidebar entries could be tightened further; currently relies on Tailwind defaults

**Why:** Risograph adaptation for dark-industrial app must use colored offset shadows (not black) to remain visible. Token naming parallels CrowForge convention but values differ.
**How to apply:** Always check surface darkness before choosing shadow color. Use accent shadows on dark surfaces, dark shadows on lighter overlay surfaces (dialogs).
