# Contributing to Pod

Thanks for helping. Pod is the Tauri app in `windows/` (Windows and Linux).

## Run it
```
cd windows
npm install
npm run tauri dev
```

## Font
Pod's interface is set in PP Mori by Pangram Pangram. Its licence doesn't allow redistributing the files, so they aren't in the repository. If you have a licence, put the six `PPMori-*.otf` files (Extralight, Regular, SemiBold and their italics) in `windows/public/fonts/local/`; the folder is ignored by git. Without them Pod uses the system font.

## Before a pull request
```
cd windows
npx tsc --noEmit
npm test
cargo test --workspace
python scripts/test-whats-new.py
```

## Rules
- Local first, with no API keys and no accounts. Network calls go only to things the user set up (calendar links, update checks, the one-time ffmpeg download).
- No telemetry.
- Every user-facing string goes through `t()` and is translated in the 14 languages (`windows/src/i18n/extra.json`).
- Efficiency budget: 0 % CPU while the island is hidden, under 0.5 % of a core when idle. Prefer events to polling, and animate only `transform` and `opacity`.
- Keep the existing look. New views follow the island's style.
