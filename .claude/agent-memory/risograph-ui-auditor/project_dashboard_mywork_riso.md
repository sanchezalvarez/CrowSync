---
name: Dashboard MyWorkSection Riso Audit 2026-03-31
description: Targeted riso audit and enforcement pass on the MyWorkSection component in DashboardPage; covers member pills, card headers, row items, empty states, stats bar
type: project
---

MyWorkSection in `src/pages/DashboardPage.tsx` received a focused Risograph consistency pass on 2026-03-31. Only this component was touched — no other sections were modified.

**Why:** Section was partially riso-styled but had several inconsistencies vs. the established design system: hardcoded rgba dividers, generic `hover:bg-muted/50`, non-unified severity tags, weak empty states, inconsistent stats bar.

**Changes applied:**

1. **Member picker pills** — added `rounded-sm` (was `rounded`), added explicit `color` token (teal when active, `muted-foreground` when inactive), added `letterSpacing: "0.03em"`, avatar dot shrunk from `w-5 h-5` / `text-[8px]` to `w-4 h-4` / `fontSize: 7` for tighter pill proportions. Unselected pills now get a faint `foreground 4%` background rather than transparent, giving them visual weight without competing with selected state.

2. **Card headers** — count moved from inline `({activeTasks.length})` in the label to a separate pill badge pushed to the right with `ml-auto`. Teal badge for Tasks, destructive badge for Bugs. Header padding unified to `py-3` (was `py-2.5`). Icon sizes unified to `size={11}`.

3. **Row item hover** — replaced `hover:bg-muted/50` Tailwind class with `onMouseEnter`/`onMouseLeave` handlers using `color-mix(in srgb, var(--accent-teal) 5%, transparent)` for Tasks and `color-mix(in srgb, var(--destructive) 5%, transparent)` for Bugs — tinted hover that matches each card's accent.

4. **Task row tags** — item_type tag changed from uncolored `tag-riso` to `tag-riso tag-riso-teal`. Status tag kept as `tag-riso-muted`. Added `shrink-0` to both to prevent truncation squeeze.

5. **Bug severity tags** — previously used inline `style={{ color, borderColor }}` with custom font-size/padding — replaced with a `severityTagClass()` helper that maps to proper `tag-riso` classes: Blocker → `tag-riso tag-riso-orange`, Major → plain `tag-riso`, Minor → `tag-riso tag-riso-muted`.

6. **Empty states** — was a bare `<div className="p-4 text-center text-xs text-muted-foreground">` — now a vertically centered column with the relevant icon (faded, `opacity-40`) above a `font-mono-ui tracking-wide` label. Padding increased to `py-6` for breathing room.

7. **Row item dividers** — changed from hardcoded `rgba(20,16,10,0.06)` to `var(--border)` for dark mode correctness.

8. **Summary stats bar** — was a bare flex row with `mt-2` and `w-px h-3` dividers using hardcoded rgba. Now: faint `foreground 4%` background, `border: 1px solid var(--border-strong)`, `rounded-sm`, `px-3 py-2`. Dividers changed to `self-stretch` `w-px` elements using `var(--border-strong)`. Shows when any of activeTasks, activeBugs, or resolvedCount > 0 (previously only tasks or bugs).

9. **Loading state** — previously a bare card with just a spinner. Now has a matching stripe header with Loader2 icon and "Loading…" mono label — layout matches the populated state so there's no height jump.

10. **Grid gap** — `gap-5` → `gap-4` (20px → 16px) for tighter, more print-like rhythm.

**How to apply:** When auditing other list-based card sections in CrowForge, use these patterns: count badges in card headers via `ml-auto` pill, accent-tinted hover per card accent color, `tag-riso-*` classes for all pills/badges, `font-mono-ui` + icon for empty states, `var(--border)` for row dividers.
