---
description: Generate your Claude Code Wrapped — visualize and share your stats
allowed-tools: Bash, Read
---

You are generating a Claude Code Wrapped for the user. Follow these steps exactly:

## Step 1: Run the extraction script

Run the extraction script to parse the user's Claude Code data and generate a summary payload:

```bash
bun run "$(ls -td ~/.claude/plugins/cache/claude-code-wrapped/claude-code-wrapped/*/ 2>/dev/null | head -1)src/extract.ts"
```

If bun is not available, fall back to node:
```bash
node "$(ls -td ~/.claude/plugins/cache/claude-code-wrapped/claude-code-wrapped/*/ 2>/dev/null | head -1)dist/extract.js"
```

The script will:
1. Parse ~/.claude/history.jsonl for session history
2. Parse ~/.claude/projects/**/*.jsonl for transcript data (tool usage, timestamps)
3. Parse ~/.claude/usage-data/facets/*.json for goal/outcome data (if available)
4. Compute aggregate stats, time patterns, archetype, and highlights
5. POST the ~2KB summary payload to the API
6. Print the resulting URL

## Step 2: Open the URL

Once the script prints the URL, open it in the user's browser:

```bash
open <URL>
```

On Linux use `xdg-open` instead of `open`.

## Step 3: Inform the user

Tell them:
- Their Wrapped is ready and opening in their browser
- Only aggregate stats were shared (no code, prompts, or project names)
- They can share the URL or download the card as an image
