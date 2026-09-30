# ADR 0008 · Realm View rendered with PixiJS from non-redistributable pixel art
**Status**: accepted · 2026-09-29

## Context
The user supplied the Cute Fantasy asset packs (`assets/`) and wants the cluster shown as
a fantasy world. We need a 2D renderer that handles thousands of animated sprites in the
browser and inside Tauri webviews, and a way to use commercially licensed art that may
not be redistributed.

## Decision
- **PixiJS v8** as the renderer, embedded in the existing React app as one component.
  Not Phaser (full game engine, heavier, own scene/loop model that fights React) and not
  plain canvas/DOM (no batching; thousands of animated sprites would not hold 60 fps).
- A **pure TypeScript world builder** turns Kubernetes objects into a scene model; the
  renderer only syncs sprites to that model. The builder is unit-tested without WebGL.
- **Assets stay out of git.** A manifest lists the files used; a script copies them from
  a local path into a git-ignored public folder at build time. Missing assets degrade to a
  placeholder page, so open builds and CI keep working. The free pack is excluded (its
  licence is non-commercial).
- Sprite mapping rules are documented in docs/11-realm-view.md and are the single source
  of truth; changes to the mapping are doc changes first.

## Consequences
+ 60 fps with thousands of sprites, same component on web, desktop and mobile.
+ Legal: no art in the repository or in public images.
− Two rendering worlds in the app (DOM + WebGL); interactions must bridge (hover/click → React drawers).
− Bundle +~400 KB (lazy-loaded only on the Realm route).
