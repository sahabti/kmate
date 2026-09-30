# ADR 0005 · Tauri 2 for desktop and mobile shells
**Status**: accepted (mobile re-validated at phase 6) · 2026-09-24

## Context
Need native shells around the SPA. Electron is desktop-only and heavy (~150 MB). Capacitor is mobile-first.

## Decision
Tauri 2: Windows/macOS/Linux plus Android/iOS from one Rust core, ~10 MB installers, OS webview, first-class plugins (keychain/stronghold, biometric, notifications, deep-link, updater). Rust also lets us implement the native port-forward TCP listener on desktop.

Fallback for mobile: **Capacitor** wrapping the same SPA if a phase-6 spike finds blocking issues.

## Consequences
+ Smallest binaries, one shell tech for 5 targets.
− Requires Rust toolchain in CI and on dev machines (not yet installed here — needed at phase 5).
