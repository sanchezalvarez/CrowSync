# UI Fix Skill
## UI Fix Skill
1. Read ONLY the specific file and element the user mentions
2. Make ONLY the requested change - do not modify any surrounding elements
3. Run `npx tsc --noEmit` to verify no type errors
4. Show a before/after summary of ONLY what changed
5. If the fix doesn't work on first attempt, revert and ask user for guidance
