---
name: ChatPage + AgentPage Riso Audit 2026-03-31
description: Full riso design pass on ChatPage and AgentPage — sidebar, header, bubbles, input area, streaming indicators, context menus
type: project
---

Final design pass applied to both chat interfaces on 2026-03-31.

**Why:** Both pages share a nearly identical layout but had mixed styling — raw Tailwind violet/blue classes, generic shadcn heights, inconsistent avatar sizes, missing riso class usage.

**How to apply:** Use the patterns below as the canonical spec for any future chat-style pages.

## Sidebar (both pages)
- Height reduced from `h-20` to `h-14` for the header row holding the New Chat button
- Added `surface-noise` class to the sidebar container
- Added `riso-section-label` above the session list
- Session items: `font-mono-ui text-xs` for title text; active state uses `color-mix(in srgb, var(--accent-*) 10%, transparent)` background + matching border via inline styles (Tailwind can't use `--accent-teal/10` without `@theme inline` registration)
- Session rename input: `border-b` with `borderColor: 'var(--accent-*)'` inline style

## Header
- Height reduced from `h-20` to `h-14`
- Session title: `font-display font-bold text-base riso-misreg-hover`
- ChatPage: Mode label uses `riso-section-label`; document connect/disconnect buttons use `btn-tactile btn-tactile-teal` / `btn-tactile-outline`
- AgentPage: title shows session name OR "Agent Mode" fallback; Context/KB/Web buttons use `btn-tactile btn-tactile-violet` (active) / `btn-tactile-outline` (inactive)

## Context menus (dropdown overlays)
- Use `bg-card border border-border-strong rounded-md card-riso` (+ color variant) instead of generic `shadow-lg`
- Text inside uses `font-mono-ui text-xs`

## Message bubbles
- Avatars: both user and assistant standardized to `w-8 h-8` (was mismatched: user `w-14 h-14`, assistant `w-7 h-7`)
- `animate-msg-in` added to each message row
- User bubble: ChatPage uses `bg-primary card-riso card-riso-orange`; AgentPage uses `bg-[var(--accent-violet)] card-riso card-riso-violet`
- Assistant bubble: ChatPage uses `bg-card riso-bubble-ai`; AgentPage uses `bg-card riso-bubble-ai-violet` (new CSS class added to index.css)
- Gap between avatar and bubble: `gap-2.5`

## Streaming / loading indicator
- Replaced single `<Loader2>` spinner with three colored dots using `animate-riso-pulse`
- Colors: teal + orange + violet for ChatPage; violet + orange + teal for AgentPage
- AgentPage "Agent is thinking..." text alongside dots, in `font-mono-ui text-[11px]`

## Input area
- Container gets `surface-noise` class
- Textarea: `border-border-strong` added; ring uses default `--ring` token (accent orange)
- Attached file chip: uses `tag-riso tag-riso-teal` instead of raw primary/border classes
- AgentPage: Send button uses `btn-tactile btn-tactile-violet` instead of inline style override

## AgentToolBubble (tool call steps)
- Container: `color-mix(in srgb, var(--accent-violet) ...)` inline styles instead of `bg-violet-500/5 border-violet-500/20`
- Apply button: `btn-tactile btn-tactile-violet` instead of `bg-violet-600`
- Thinking text: `font-mono-ui` + inline color
- Wrench icon: inline `style={{ color: 'var(--accent-violet)' }}`

## AgentStatusBanner
- Uses `color-mix(in srgb, var(--accent-violet) 10%/30%, transparent)` + `font-mono-ui text-[11px]`
- `animate-riso-pulse` for gentle attention pulse

## Banners (tool warning, scope warning)
- Tool support warning: uses `--accent-gold` colors via inline styles
- Scope warning: `font-mono-ui text-[11px] border-border-strong`

## ContextSelector
- Labels: `riso-section-label`
- Checkboxes: `style={{ accentColor: 'var(--accent-violet)' }}`
- List items: `font-mono-ui text-xs`
- Select all/clear buttons: `btn-tactile btn-tactile-outline` with compact padding override

## New CSS class added to index.css
- `.riso-bubble-ai-violet` — violet + orange offset shadow variant for AgentPage assistant bubbles

## Key rule: accent color Tailwind classes
Tailwind v4 cannot use `bg-accent-teal/10` or `bg-accent-violet/10` because `--accent-teal` / `--accent-violet` are NOT registered in `@theme inline` as `--color-accent-teal`. Always use `color-mix(in srgb, var(--accent-*) N%, transparent)` via inline styles for opacity variants of custom accent colors.
