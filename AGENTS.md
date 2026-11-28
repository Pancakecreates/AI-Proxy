# Project Notes

## Verification

- Root TypeScript tests: `npm test`
- Root TypeScript typecheck: `npm run typecheck`
- Desktop frontend build/typecheck: `npm --prefix desktop run build`
- Rust tests: `cd desktop/src-tauri && cargo test --lib`
- Rust compile check: `cd desktop/src-tauri && cargo check --all-targets`

`cargo fmt --check` currently reports broad pre-existing formatting drift across the Rust tree; avoid whole-file reformatting when making scoped changes.
