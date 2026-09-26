# Architecture

The application has four dependency layers:

1. `src/data`: generated, versioned standard species data plus separately maintained PokeMMO overrides.
2. `src/domain/breeding`: pure TypeScript rules, inheritance domains, simulator, bounded deterministic planner and independent validator. It has no Electron, React or database imports.
3. `src/main`: SQLite migrations/repositories, transactions, snapshots, backups, imports, sprite cache and narrow validated IPC handlers.
4. `src/renderer`: React desktop UI. The planner runs in a Web Worker so search cannot freeze rendering. The renderer receives only the API exposed by the sandboxed preload.

Planner objectives are lexicographic. Every optimizer mode first minimizes breeding operations, then favors owned Pokémon from the target's evolution line; the selected mode only changes tie-breaks between plans with equal cost and lineage use. Search uses bounded best-first frontier expansion, functional-state bucketing, provenance-aware de-duplication, dominance pruning and deterministic tie-breakers. If the bounded mixed-inventory search cannot find a plan, a deterministic externally sourced template is built from simple one-IV/nature constraints and validated; it is clearly reported in diagnostics rather than presented as an optimality proof.

Each node carries immutable provenance sets. Candidate branches may merge only when inventory IDs and missing placeholder IDs are disjoint. `PlanValidator` repeats that check independently.

SQLite production, development and test paths are separated. Production data lives below Electron `app.getPath('userData')`; development uses a sibling `PokeMMO Breeding Planner Dev` directory; tests use temporary databases.
