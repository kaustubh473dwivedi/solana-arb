# CLAUDE.md

See SYSTEM.md for full architecture. Key rules:

- src/strategy/crossDex.ts is the focus of all work here. src/strategy/collector.ts is a separate, out-of-scope tool — don't modify or "clean up" it incidentally.
- Never add real transaction signing/sending — this is paper-trading only.
- DEX readers (src/onchain/*) must return null on failure, never throw — a cross-check failure must never break the main scan loop.
- swapMath.ts stays pure (no network calls) and numerically stable — avoid formulas like L·(1/a − 1/b) that cancel catastrophically; use the rewritten stable forms already in the file as the pattern.
- Broken ESM SDKs (meteora dlmm, orca whirlpools, openbook-v2) are worked around via createRequire(import.meta.url) — follow this existing pattern, don't "fix" it by switching to dynamic import.
- Run `npx tsc --noEmit` before considering a change done.
