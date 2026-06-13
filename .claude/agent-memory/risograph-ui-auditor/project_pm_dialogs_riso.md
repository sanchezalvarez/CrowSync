---
name: PM Dialogs & Detail Panel Riso Audit 2026-03-31
description: Riso styling applied to PM popup/dialog/panel components — TaskDetailPanel, TaskForm, SprintView New Sprint dialog
type: project
---

Riso treatment applied to the three PM popup/dialog/panel components on 2026-03-31.

**Why:** Bring form surfaces into the established Risograph design language — matching the card-riso / btn-tactile / surface-noise patterns used elsewhere in PM views and Settings.

**How to apply:** These patterns are now the canonical spec for any new PM dialogs or slide-out panels:

### TaskDetailPanel (`src/components/PM/TaskDetailPanel.tsx`)
- Panel container: `surface-noise` class, `borderLeft: 1.5px solid var(--border-strong)`, riso teal offset shadow `boxShadow: "-4px 0 0 var(--riso-teal)"`; removed generic `border-l border-border shadow-2xl`
- All section labels (Description, Acceptance Criteria, Activity, Parent, Status, Assignee, Due, Sprint): `font-mono tracking-wide uppercase` — replaces plain `font-mono`
- Description textarea: `border: 1.5px solid var(--border-strong)`, removed `border-0 focus:ring-1 focus:ring-primary`
- Acceptance Criteria Textarea: same border treatment, `focus-visible:ring-0`
- Due date input: `border: 1.5px solid var(--border-strong)`, removed `border border-border focus:ring-1 focus:ring-primary`
- All three SelectTrigger components: `border: 1.5px solid var(--border-strong), boxShadow: none`, removed `border-0`
- Parent picker search input: `border: 1.5px solid var(--border-strong)`, removed `border border-border focus:ring-1 focus:ring-primary`

### TaskForm (`src/components/PM/TaskForm.tsx`)
- DialogContent: added `surface-noise` class, `border: 1.5px solid var(--border-strong)`
- DialogTitle: added `font-display font-black tracking-tight`
- All Label elements: added `font-mono text-xs text-muted-foreground`
- All text inputs: `border: 1.5px solid var(--border-strong)`, removed shadcn ring/focus styles
- Both Textarea elements: same border treatment, `focus-visible:ring-0`
- All SelectTrigger: `border: 1.5px solid var(--border-strong), boxShadow: none`
- Replaced `<Button variant="ghost">` Cancel → `<button className="btn-tactile btn-tactile-outline">`
- Replaced `<Button type="submit">` → `<button className="btn-tactile btn-tactile-teal">`
- Removed unused `Button` import from `../ui/button`

### SprintView — New Sprint Dialog (`src/components/PM/SprintView.tsx`)
- DialogContent: added `surface-noise` class, `border: 1.5px solid var(--border-strong)`
- DialogTitle: added `font-display font-black tracking-tight`
- All Label elements: added `font-mono text-xs text-muted-foreground`
- All four text/date inputs: `border: 1.5px solid var(--border-strong)`, removed shadcn ring/focus styles
- Replaced `<Button variant="ghost">` Cancel → `<button className="btn-tactile btn-tactile-outline">`
- Replaced `<Button type="submit">` → `<button className="btn-tactile btn-tactile-teal">`
- Removed unused `Button` import from `../ui/button`

**Build check:** Pre-existing TS errors in `stress.bench.ts` and `SettingsPage.tsx` only — none introduced by these changes.
