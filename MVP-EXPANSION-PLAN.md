# MVP Expansion Plan

## Goal

Expand the working A-Frame/Maximilian MVP into a tutorial-complete browser package with sample playback and reusable tutorial infrastructure.

## Phases

1. Core stability baseline

- Keep click-safe defaults (BLEP oscillator option, SVF path, compile dedupe)
- Keep robust init-order compile retries

1. Sample pipeline

- Add `maxi-sample` component
- Queue and async load sample assets from main thread before playback nodes are fully active
- Ensure sample nodes fail-safe to silence until `isReady()`

1. Tutorial coverage

- Provide runnable browser versions for tutorials 1-24
- Mark entries as adapted where browser/patch-layer parity differs from C++ originals
- Centralize all tutorials in one dynamic player to reduce maintenance

1. UX and deployment

- Add a dedicated catalog page for all tutorials
- Keep home page links to quick demos and full catalog
- Publish via GitHub Pages on each update

## Current status

- [x] Sample component support added (`maxi-sample`)
- [x] Full tutorial catalog page added
- [x] Dynamic tutorial player added for tutorials 1-24
- [x] Home index updated to include full catalog
- [ ] Optional polish pass (status HUD, source-map noise cleanup, extra per-tutorial visuals)
