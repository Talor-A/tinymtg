# tinymtg

A tiny, correct, fast Magic: The Gathering rules engine.

## About tinymtg

tinymtg is an implementation of the Magic: the Gathering game, written in TypeScript. 

The core engine is approximately 10k lines of code in `index.ts`, meaning it can be read
top-to-bottom and understood completely. It's designed to be supremely readable, with heavy 
use of comments, rules references, and type guarantees.

## Why make this?

Magic: the Gathering is my favorite game. I was curious how complex the game I loved to play would be to
turn into code. there's several existing open-source engines out there, but all of them are quite complex
projects. 

This codebase was hand-crafted to be a reference for the core rules that make Magic work, and an experiment
to fit the entire complex game into a reasonable size, small enough to be understood quickly, without taking
shortcuts around correctness.

## Features
Currently, approximately 5,000 of Magic's 33,000+ cards are playable in the engine. 

It supports these features from Magic the Gathering:

1. All core features like attacking, blocking, playing lands, casting spells, and paying mana.
1. Activated abilities from any zone. 
1. Triggered abilities from any zone.
1. Extra costs on spells and abilities: pay life or sacrifice permanents.
1. Static effects, including correctly implemented layers and copiable characteristics.
1. Replacement effects, up to the complexity level of [Chains of Mephistopheles](https://scryfall.com/card/me1/63/chains-of-mephistopheles?utm_source=tagger).
1. Extra turns and phases ([Time Walk](https://scryfall.com/card/ovnt/2011/time-walk)), and skipped turns and phases.
1. Searching, scrying, surveiling.
1. Playing from other zones.
1. Many keywords, such as trample, deathtouch, flying, reach, indestructible, hexproof, shroud, and prowess.

More advanced features:

1. The engine is fully deterministic. It can be rewound and replayed correctly, or forked with new actions.
2. The engine can operate fully synchronous or fully async. It uses a [React Suspense](https://www.epicreact.dev/how-react-suspense-works-under-the-hood-throwing-promises-and-declarative-async-ui-plbrh#:~:text=Here's%20the%20wild%20part:%20Suspense%20works%20by%20catching%20thrown%20promises)-like system, to retrieve player responses as either blocking or non-blocking. So, it's suitable for fast, single-threaded rollouts as well as request-response non-blocking live play.
3. Cards can be generated en-masse with structured effect representations, or hand-authored with custom callback logic.

## Not Yet implemented
1. Visibility: revealing a card from your hand, looking at a player's hand to force them to discard, face-down exiled cards
2. Planeswalkers.
2. Cost reductions or increases.
3. Alternate costs, including flashback, madness, foretell, plot, etc.
4. Dual-face cards.
5. Compound / split cards: Adventures, Omens, Fuse.
6. A few evergreen keywords like first strike and double strike.
7. Many non-evergreen keywords.
8. Player-specific logs.

A playable web client is in progress.

## AI Usage

The tinymtg engine code itself is primarily hand-designed and implemented. 

AI was used heavily for writing exhaustive correctness tests and for writing the automated Forge parser / importer. 
This primarily AI-authored code lives outside the core 10k-line `index.ts` file.

## Acknowledgements

This codebase owes a huge debt of gratitude to the [Forge Engine](https://github.com/Card-Forge/forge) project. I've
used their card definition syntax to power almost all of the 5k currently supported (and constantly growing) cards
used by tinymtg.

## Setup

```bash
bun install
bun run index.ts

bun run check       # typecheck and test
bun run fix         # autofix all files
```
