---
name: Dialogs & Overlays Riso Audit 2026-04-01
description: Full Risograph audit of all popup/dialog/overlay/context-menu components across the app
type: project
---

All dialog/modal/overlay/context-menu surfaces now follow the canonical Riso pattern. Changes applied 2026-04-01.

**Why:** Prior to this pass, all Sheet dialogs, Canvas context menu, and document import dialogs used generic shadcn styling (bg-background, border-border, shadow-lg) with Button component. These are now fully riso-enforced.

**How to apply:** Any new dialog or overlay surface should follow this pattern below.

## Canonical dialog panel pattern

```tsx
<div
  className="card-riso card-riso-{teal|orange|violet} surface-noise riso-frame {w-...} p-5 rounded-lg relative overflow-hidden animate-ink-in"
  style={{ border: "1.5px solid var(--border-strong)", boxShadow: "4px 4px 0 var(--riso-{teal|orange|violet})" }}
>
  {/* Riso color strip */}
  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, borderRadius: "6px 6px 0 0", background: "var(--riso-strip)", opacity: 0.75 }} />
  <h3 className="font-display font-black text-sm tracking-tight mt-1">Title</h3>
  ...
</div>
```

## Color accent assignment by role
- **Teal**: filter/sort/import/template operations (neutral utility)
- **Orange**: generate rows, AI fill, template creation (generative/creative)
- **Violet**: AI operations, formula wizard, AI range op (AI-specific)
- **Mixed**: delete confirmation uses `card-riso-orange` with destructive button

## Dialog component (src/components/ui/dialog.tsx)
DialogContent base now has: `surface-noise`, `card` background, `border-strong` border, `4px 4px 0 var(--riso-teal)` box-shadow, riso color strip at top. DialogTitle: `font-display font-black`. DialogDescription: `font-mono-ui text-xs`.

## Button pattern in dialogs
Replace all `<Button variant="outline">` with `<button className="btn-tactile btn-tactile-outline">`.
Replace all `<Button variant="default">` with `<button className="btn-tactile btn-tactile-{color}">`.
Replace all `<Button variant="destructive">` with `<button className="btn-tactile" style={{ background: "var(--destructive)", ... }}>`.

## Context menus (right-click overlays)
Use inline style: `border: "1.5px solid var(--border-strong)"`, `background: "var(--card)"`, `boxShadow: "3px 3px 0 var(--riso-{teal|orange})"`, `backgroundImage: "var(--noise-subtle)"`.
Menu items: `font-mono-ui text-xs hover:bg-muted/60 transition-colors`.
Separators: `<div className="h-px my-1 bg-border-strong" />`.

## Files fixed
- src/components/ui/dialog.tsx — base DialogContent/Title/Description
- src/components/sheets/SheetDialogs.tsx — 4 overlays (template, AI gen, AI range op, gen rows)
- src/components/sheets/CondFormatDialog.tsx — full rewrite
- src/components/sheets/MultiSortDialog.tsx — full rewrite
- src/components/sheets/FormulaWizard.tsx — full rewrite
- src/components/sheets/SheetContextMenus.tsx — col menu, row menu, filter popup, formula explain popover, delete confirm
- src/components/sheets/SheetSidebar.tsx — new sheet picker modal
- src/editor/DocumentEditor.tsx — import dialog
- src/pages/SheetsPage.tsx — import dialog
- src/components/Canvas/CanvasToolbar.tsx — keyboard shortcuts overlay
- src/components/Canvas/CanvasContextMenu.tsx — right-click context menu

## SplashScreen status
Already fully riso-compliant from previous session. Has: card-riso, riso-frame, animate-ink-in, riso-strip, registration crosshairs, halftone dots, blob drifts, riso-title, riso-stamp-press, surface-noise-flat, animate-riso-pulse.

## Already-compliant dialogs (no changes needed)
- ProjectsPage: all 3 dialogs (standup, create project, delete confirm) — correct
- ProjectDetailPage: all 3 dialogs — correct
- IssueTrackerPage: bug report dialog — correct, best-in-class example
- PM/TaskForm.tsx: correct
- PM/SprintView.tsx: new sprint dialog — correct
- SettingsPage: delete confirm dialog uses card-riso-orange correctly
