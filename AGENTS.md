## Finding Cards

to find cards, check:

```
./cards/cardsfolder/<first-letter-of-card-name>/<card_name>.txt
```
if the cards db doesn't exist in your worktree, you can do a quick `cp -r` from 
the root worktree.

Always reference a card's definition rather than guessing.

If you see a card implementation that does not match its definition, flag it.
Incorrect implementations lead to lying tests and latent bugs.

## Codebase goals

This is a proof-of-concept codebase intended for maximum readability and 
absolute correctness. Coding standards:

- use asserts to prove invariants.
- do not obscure logic behind helper functions.
- types should exactly represent their use case.

## Engine Implementation

The engine is approximately 6k lines, with a final target of < 10k lines. This 
is not very large, and the engine can be understood completely from one file.
