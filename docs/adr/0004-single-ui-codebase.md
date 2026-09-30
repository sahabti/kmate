# ADR 0004 · One React/TypeScript UI for web, desktop and mobile
**Status**: accepted · 2026-09-24

## Context
Five targets (web, Windows, macOS, Linux, Android, iOS). Separate native UIs would triple the frontend effort.

## Decision
One React 19 + TypeScript SPA (`apps/web`) with responsive layouts. Desktop and mobile shells load the same bundle. Platform-specific behaviour is injected through a small `platform` interface (`keychain`, `openExternal`, `portForwardListen`, `biometric`, `notifications`) with web / Tauri implementations.

## Alternatives
- Flutter for everything: single codebase too, but weaker web story for dense tables/Monaco/xterm ecosystem.
- React Native + react-native-web: web output is second-class; desktop needs yet another shell.

## Consequences
+ Feature parity by construction.
− Mobile UX needs deliberate responsive design; heavy components (Monaco) are lazy-loaded and simplified on mobile.
