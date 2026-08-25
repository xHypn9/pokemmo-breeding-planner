# PokeMMO Breeding Planner

> [!WARNING]
> **Work in progress / progetto ancora in sviluppo.** This is an experimental, unofficial build and may contain incomplete features or planner/scanner defects. Keep backups of important inventory data and verify every breeding plan in game before consuming Pokémon.

An unofficial, fully local Windows desktop application for managing real breeder inventory and producing deterministic PokeMMO breeding trees. It does not connect to the PokeMMO client, GTL or any cloud service.

The planner treats inventory Pokémon as consumable resources. A Pokémon ID can occur in only one branch. Every candidate plan is independently re-simulated from leaves to root; the UI never labels a target valid when an IV, nature, Alpha state or HA requirement depends on RNG.

## What works in V1

- Dense inventory with Boxes, combined filters, sortable columns, edits, deletion and bulk Box/Nature/Alpha/HA updates. An owned Pokémon can be marked `Unavailable` individually or in bulk: it stays in My Pokémon but is excluded from every Planner search until re-enabled.
- Keyboard-friendly Quick Insert grid with TSV paste, row duplication, immediate validation, automatic species metadata and a scrollable keyboard-navigable autocomplete.
- Fully local PokeMMO Box Scanner with window-only capture, normalized ROI calibration, offline OCR, visual Alpha/HA/gender detection, per-field confidence and editable review queue.
- Direct ROI calibration on the full captured PokeMMO window: drag colored areas with the mouse and resize them from their corner handles; numeric percentages remain available for fine tuning.
- Three-pass IV OCR with contrast variants and per-stat consensus; disagreements such as `14` versus `18` are corrected by majority and the affected stat is explicitly sent to review.
- Automatic `PC Deposit Box` location from its title bar on every capture, with field ROIs derived from the detected Box and manual offsets retained only as fallback.
- Explicit `✓ OK` review approval after manual corrections, multi-pass species OCR, weak-gender review suggestions and live scanning with immediate first capture, tolerant visual change detection and semantic duplicate suppression.
- Scanner import preflight isolates malformed rows, imports the valid subset, keeps rejected rows visible with their exact reason, and shows unexpected IPC/database errors without truncation.
- Inventory and Box Scanner accept every bundled Pokémon, including non-breedable species; the Planner alone decides which owned records are legal parents and ignores the others.
- Single Scan, stable-frame live scanning, and a configurable global manual-capture hotkey that never sends input to the game.
- A bundled offline dataset for National Dex 1–649, generated from PokéAPI, plus a separate PokeMMO override layer.
- PokeMMO compatibility, gender, Ditto, genderless-line, IV-domain, Brace, Everstone, nature, Alpha and HA-potential rules.
- Bounded deterministic planner with provenance sets, pruning, cancellation, worker progress and generic missing-breeder constraints.
- Inventory-first fallback preserves complete owned multi-IV branches. The target line is required on the female side, while male branches may remain any compatible species sharing an Egg Group until the final cross.
- Nullable target IVs: leaving a field empty marks it `IGNORE`, removes it from planner constraints and skips it during final validation.
- Per-stat target modes: `25+` means a guaranteed minimum from 25 through 31, while the `Exact` checkbox keeps a precise IV requirement. `0+` is unconstrained and cannot create a useless extra breeding tier.
- New IV values from 0–30 default to minimum mode and normalize to a visible `+`; 31 is always Exact because no higher IV exists.
- Planner searches show the current phase, explored states out of 18,000 and an elapsed timer; only one worker can run, so repeated Calculate clicks cannot restart or duplicate the computation.
- Tabs are mounted lazily and then kept alive for the application session, preserving Planner work, Quick Insert rows, filters and Scanner review state while shared inventory data continues to refresh.
- Box Scanner automatically discovers and accepts only the real PokeMMO window; the manual source picker and misleading static Offline label are removed.
- Scanner calibration v2 captures complete information rows instead of narrow value offsets. Species and gender share the full name row; IVs and Nature use their complete labeled rows; HA requires both golden/orange Ability text and its cyan diamond, with mismatched cues sent to review.
- Automatic discovery normalizes every Cyrillic or Greek lookalike used by the changing PokeMMO window title (for example `РokеMМO`) and reacquires the window if Electron changes its source ID between discovery and capture. Administrator privileges are not required.
- Independent `PlanValidator` and automatic revalidation after replacing a missing breeder.
- Interactive React Flow tree with zoom, pan, fit, node details, items, selected gender and guarantee reasons.
- Persistent plans, warned recalculation, and transactional `Breed Completed`: consume parents, create child, update steps and history.
- Automatic SQLite safety snapshot before each completed breed and before restore/import, with one-click recovery of the latest snapshot.
- Versioned `.pbpbackup` archives and readable JSON export/import.
- Development-only 50-breeder seed and planner diagnostics.

## Stack and security

- Electron 43, React 19, TypeScript, Vite/electron-vite
- built-in `node:sqlite` (`DatabaseSync`), avoiding native-addon rebuild failures on Windows paths with spaces
- `@xyflow/react`, Zod, Sharp, Tesseract.js with bundled English data, Vitest and electron-builder/NSIS
- `nodeIntegration: false`, `contextIsolation: true`, renderer sandbox, CommonJS preload, frozen `contextBridge` API
- validated narrow IPC handlers; database, backup, filesystem and sprite cache live in the main process
- production CSP blocks remote scripts and connections; no remote code is loaded
- personal SQLite databases, backups, scanner debug output, development profiles and user-provided screenshots are excluded from the public repository

## Development

Requirements: Windows 10/11 and Node.js 24 or a current Node release containing `node:sqlite`.

```powershell
npm install
npm run dev
npm run test
npm run build
npm run dist
```

pnpm is also supported (`pnpm install`, `pnpm dev`, and so on). The root postinstall ensures the Electron runtime is present; there are no native SQLite addons to rebuild.

Useful commands:

```powershell
npm run demo:planner
npm run seed:demo
npm run update-species-data
```

`seed:demo` writes only to `development-data/planner.sqlite` unless another output path is passed. Automated tests always use temporary databases.

## Offline species dataset

The user never needs to supply Egg Groups or metadata. Run:

```powershell
npm run update-species-data
```

The repeatable updater downloads PokéAPI species/evolution data, normalizes it and writes `src/data/species.generated.json`. This generated file is versioned and bundled into the renderer/main output. Normal app use requires no Internet.

PokeMMO corrections remain in `src/data/pokemmo-overrides.json`; the updater never overwrites them. See `docs/pokemmo-breeding-rules.md` for sources, confidence and explicit assumptions.

Sprites use a separate provider abstraction. The main process fetches a small PokéAPI sprite on first use, validates its size, stores it below user data and returns a data URL. Offline cache hits work normally; an unavailable sprite becomes a placeholder and never affects planning.

## Project structure

```text
src/data/                 generated standard data + PokeMMO overrides
src/domain/breeding/      pure rules, inheritance, simulator, planner, validator
src/main/scanner/         offline OCR and visual indicator recognition
src/main/database/        centralized migrations and repositories
src/main/services/        backup, sprite, capture and fingerprint providers
src/main/index.ts         hardened window and validated IPC boundary
src/preload/              restricted typed bridge
src/renderer/             React UI and isolated planner Web Worker
tests/                    rules, planner, validator, SQLite and backup tests
docs/                     researched rules and architecture decisions
```

The renderer worker receives an inventory snapshot and a target, but no filesystem or Node access. SQLite is always owned by the main process.

## PokeMMO Box Scanner

The scanner observes a user-selected PokeMMO window through Electron `desktopCapturer`. It does not inspect process memory, inject code, sniff packets, read game files, or click/type in PokeMMO. Sharp crops the calibrated regions and Tesseract.js runs locally in a worker thread. The English OCR model is included in the installer, so scanning needs no Internet and no Python runtime.

Workflow:

1. Open the PC Box and select a Pokémon in PokeMMO.
2. In `Box Scanner`, choose the PokeMMO source window and destination Box.
3. Use `Recalibrate` when the window size, DPI scaling, theme, or PokeMMO UI scale differs from the default profile.
4. Run `Scan Current Pokémon` first. Enable `Show Debug Crops` to inspect the six recognition regions.
5. Start live scanning and click Pokémon one by one, or enable the manual hotkey (default `Ctrl+Shift+S`).
6. Correct uncertain fields in the Review Queue, then press `Import Verified`.

No capture enters SQLite directly. Before import, every row is revalidated against the bundled species, gender and IV rules. Malformed rows stay in Review Queue with their exact reason; the remaining valid subset uses the same atomic `inventory.bulkCreate` path as normal entry. Non-breedable Pokémon are valid inventory records and import normally, but the Planner excludes them from breeding candidates. Optional debug saving writes the full frame, ROI crops, OCR raw values and confidence only below the app's local `scanner-debug` directory.

Live mode recognizes a changed, stable information panel; it intentionally does not deduplicate by species/IV/nature. If two consecutive Pokémon have visually identical panels and the game slot highlight cannot be distinguished reliably, use the manual hotkey for both. Each keypress is kept as a separate review row.

## Database locations

- Installed build: `%APPDATA%\PokeMMO Breeding Planner\data\planner.sqlite`
- Development: `%APPDATA%\PokeMMO Breeding Planner Dev\data\planner.sqlite`
- Tests: unique directories below the Windows temporary directory

Maintainer smoke tests can set `POKEMMO_PLANNER_USER_DATA` before launch to force an isolated disposable profile. Normal users never need this variable.

The installed application directory never contains user data, and uninstall does not delete app data.

## Backups and recovery

`Create Backup` writes a ZIP-based `.pbpbackup` containing a consistent SQLite snapshot and `manifest.json`. Restore validates format, schema and SQLite integrity first, then creates a safety snapshot of current data before an atomic staged replacement. The latest 20 automatic safety snapshots are retained under the app user-data directory. `Restore Latest Safety Snapshot` provides explicit recovery from an accidental `Breed Completed`; a restored snapshot is marked as used so the same undo cannot be applied twice.

JSON import validates top-level shape, IDs, foreign references, species/gender, all IVs/natures, and every imported breeding plan before starting the replacement transaction.

## Planner behavior

The planner first searches the real available inventory, then a mixed inventory/external frontier. Candidate states are bucketed by functional output and pruned using deterministic lexicographic objectives. Provenance sets must be disjoint at every merge.

Before starting any search, the planner checks whether an available owned Pokémon of the exact selected species already satisfies every active IV, nature, Alpha and HA constraint. In that case it returns a valid zero-breed plan containing only that inventory record, so the Pokémon is recognized as the finished target instead of being consumed to recreate itself.

If that exact owned Pokémon already has the requested nature and is short by at most one active IV, it is pinned as the final upgrade parent. The planner builds only the complementary branch needed to preserve its existing guaranteed stats and compares that incremental plan with the other candidates. Search phases share one state budget and exclude inventory species that cannot breed directly into the target Egg Group, preventing an inventory-only pass from starving the mixed search.

If the bounded search cannot find a mixed plan within configured limits, V1 produces a validated deterministic template made from simple one-IV or natured missing constraints. It does not hide this fallback: diagnostics show the limit and reason. Generic male constraints can be satisfied by any compatible Egg Group; female constraints retain the required offspring line without naming a GTL species.

For an intermediate whose irrelevant IV or nature is genuinely not forced, the app asks for only the observed non-guaranteed fields when `Breed Completed` is pressed. All target properties remain guaranteed; automatically inventing an intermediate value would be incorrect.

An ignored target IV is not optimized, braced or added to missing-breeder requirements. Because the resulting real Pokémon still has a concrete IV, the app requests its observed value when that breed is recorded and stores it in inventory.

A minimum target such as `25+` is propagated as a real IV domain, not as a display-only shortcut: every possible final value must be at least 25. Targets saved before version 0.2.0 have no mode metadata and remain exact for backward compatibility.

## Packaging

`npm run dist` builds a configurable per-user NSIS installer in `dist/`. The database remains in Electron `userData`, outside the installed application. `asar` is enabled; the OCR worker and Sharp native runtime are unpacked automatically, while the compressed English OCR model is copied into the installer's resources.

## V1 exclusions and roadmap

Not implemented: Egg Moves, shiny/OT breeding, GTL prices, economic optimization, game-input automation, login/cloud sync, process-memory access or proprietary client asset extraction. The domain model and ruleset boundary leaves room for those future modules without coupling them to inventory persistence or the UI.

PokeMMO is a third-party game. This project is unofficial and uses no PokeMMO client code or proprietary assets.
