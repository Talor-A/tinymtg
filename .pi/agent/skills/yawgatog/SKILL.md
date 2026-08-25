---
name: yawgatog
description: Query the local Magic: The Gathering Comprehensive Rules (yawgatog-rules.md) quickly from the terminal. Supports exact rule lookup, keyword search, and regex grep. Builds a cached JSON index automatically.
metadata:
  author: tinymtg
  version: "1.0"
compatibility: Requires the tinymtg repo. Uses Bun. Reads yawgatog-rules.md and writes a cached index to .cache/yawgatog-index.json.
---

# yawgatog.ts — CLI rules lookup

A fast, local query tool for the hyperlinked Comprehensive Rules shipped as `yawgatog-rules.md`.

## Installation

Already present in the repo as `yawgatog.ts`. No extra dependencies.

## Usage

```bash
# Exact rule lookup
bun yawgatog.ts 704.3
bun yawgatog.ts 704.3a
bun yawgatog.ts R61512

# Keyword search (case-insensitive, unordered word match)
bun yawgatog.ts search "can't be prevented"
bun yawgatog.ts search "lethal damage"

# Regex grep across all rules
bun yawgatog.ts grep "state-based actions"

# Force rebuild of the cached index
bun yawgatog.ts index
```

You can also use the package script:

```bash
bun run yawgatog 704.3
```

## How it works

- Parses `yawgatog-rules.md` once and writes `.cache/yawgatog-index.json`.
- Rebuilds the index automatically when `yawgatog-rules.md` is newer than the cache.
- Stores rules by number (e.g. `704.3`) and by anchor (e.g. `R7043`) for O(1) lookup.
- Search/grep scan the pre-normalized title + body strings.

## Output

Exact lookups print the full rule text. Search/grep print the rule number, anchor, and a snippet around the first match (up to 20 results).

## Examples

```bash
# When are SBAs checked?
bun yawgatog.ts 704.3

# Find the "can't be prevented" rule
bun yawgatog.ts search "can't be prevented"

# Find all rules mentioning lethal damage
bun yawgatog.ts grep "lethal damage"
```
