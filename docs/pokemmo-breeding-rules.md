# PokeMMO breeding rules implemented by V1

Ruleset version: `pokemmo-v1-2026-08-23`
Last source review: 2026-08-23

This document is intentionally separate from the standard Pokémon species dataset. The generated dataset supplies names, National Dex IDs, standard Egg Groups, gender data and evolution chains. `src/data/pokemmo-overrides.json` and `PokeMMORuleset` define PokeMMO-specific behavior.

| Rule | V1 behavior | Source and confidence |
|---|---|---|
| Parents are consumed | Every completed breed consumes both parents and produces exactly one child. | [PokeMMO Breeding Guide](https://forums.pokemmo.com/index.php?/topic/49440-the-breeding-guide/), high; the guide explicitly describes the current consumptive model. |
| Ordinary compatibility | A breed requires opposite-gender parents sharing at least one normal Egg Group. | [Revised Breeding Guide](https://forums.pokemmo.com/index.php?/topic/142087-my-breeding-guide-revised-nov-2022/), high. |
| Child species | For ordinary pairs, the female's evolution line determines the child; the child is the hatch/base species. With Ditto, the non-Ditto line determines it. | [Revised Breeding Guide](https://forums.pokemmo.com/index.php?/topic/142087-my-breeding-guide-revised-nov-2022/), high. Nidoran male/female branch corrections are explicit overrides. |
| Select child gender | Male or female can be selected when the offspring species supports it. Fixed-gender and genderless lines remain fixed. Prices are deliberately not modeled. | [PokeMMO Breeding Guide](https://forums.pokemmo.com/index.php?/topic/49440-the-breeding-guide/), high. |
| Ditto | Ditto can breed with a breedable non-Ditto, including genderless Pokémon. Ditto + Ditto is rejected and no Ditto egg is produced. | [Administrator answer](https://forums.pokemmo.com/index.php?/topic/59372-is-it-possible-to-breed-a-ditto/), high. |
| Genderless | Genderless members of the same evolution line can breed with one another; they can also breed with Ditto. | [PokeMMO Support Manager answer](https://forums.pokemmo.com/index.php?/topic/119992-genderless-breeding/), high; also reflected in the [PokeMMO Egg Group Index](https://forums.pokemmo.com/index.php?/topic/174572-pokemon-egg-group-index-pokemmo-version/), updated 2025-08-28. |
| Undiscovered | A parent in the `no-eggs`/Undiscovered group cannot breed. | [PokeMMO Egg Group Index](https://forums.pokemmo.com/index.php?/topic/174572-pokemon-egg-group-index-pokemmo-version/), high. |
| IV inheritance | Three IV positions are directly inherited; braces force a chosen parent's value for their stat and count among those positions. Other positions use the floored parental average. Because the unforced direct positions are random, V1 tracks the complete value domain. An IV is called guaranteed only when every possible outcome is the requested value. | [PokeMMO Breeding Guide](https://forums.pokemmo.com/index.php?/topic/49440-the-breeding-guide/), medium-high: the guide is old but remains the referenced mechanics guide and no later contradictory mechanic was found. |
| Equal IVs | Equal parental values always result in that value, whether the position is directly inherited or averaged; no brace is spent. | Derived directly from the documented IV rule above; covered by tests for 0, 23 and 31. |
| Brace capacity | Each parent has one held-item slot. A parent can hold one Brace or one Everstone, never both. Two useful braces must target different stats. | [PokeMMO Breeding Guide](https://forums.pokemmo.com/index.php?/topic/49440-the-breeding-guide/), high. |
| Nature | Nature is guaranteed only by an Everstone held by a parent whose nature is already known/guaranteed. Without it V1 records the child nature as unknown and never uses it to satisfy a later guaranteed target. | [PokeMMO Breeding Guide](https://forums.pokemmo.com/index.php?/topic/49440-the-breeding-guide/), high. |
| Alpha | The child is Alpha if and only if both parents are Alpha. Alpha + non-Alpha produces a normal child. | [PokeMMO administrator answer](https://forums.pokemmo.com/index.php?/topic/147290-can-you-breed-alpha-mons/), high. |
| HA potential | HA potential passes when at least one non-Ditto HA-potential parent is in the offspring's evolution line. A female HA parent therefore passes it to her own-line child even with a cross-species male; a male needs the female/child to share his line. A non-HA species paired with HA Ditto does not gain HA. Genderless HA non-Ditto + Ditto passes HA. | [PokeMMO HA guide](https://forums.pokemmo.com/index.php?/topic/150680-simply-explained-alphas-and-alpha-hordes-generalities/) and [revised guide](https://forums.pokemmo.com/index.php?/topic/142087-my-breeding-guide-revised-nov-2022/), medium-high. |
| Different-species crosses | Allowed only through a shared Egg Group and valid genders. The female line still determines the child. HA cannot cross from a male in another evolution line. | Same compatibility/species/HA sources above, high. |

## Explicit V1 assumptions and open verification points

- The offline scope is National Dex 1–649 (the five generations represented by the currently available PokeMMO regions). Unsupported or unavailable encounters do not affect breeding-rule correctness; inventory entry remains possible for every species in this scope.
- Standard Egg Groups and gender ratios begin with PokéAPI data. PokeMMO differences must be added to `pokemmo-overrides.json`; the updater never overwrites that file.
- Manaphy is conservatively marked non-breedable in V1. Community material mentions a special Manaphy case, but a sufficiently authoritative current PokeMMO rule for the resulting species was not found during this review.
- Incense/baby-species exceptions are normalized to the first breedable ancestor in the PokéAPI evolution path. Any PokeMMO-specific exception discovered later belongs in the override file.
- Egg Moves, shiny breeding, OT rules, prices and client automation are outside V1.

## Guarantee policy

The simulator stores a set of possible values for every non-forced IV of every intermediate. The planner can use an IV toward the target only when that set contains exactly the requested value. The final node must have a singleton set equal to the target for all six IVs, a guaranteed target nature, and exact requested Alpha/HA state. `PlanValidator` independently re-simulates every step from leaves to root before a plan is marked valid.
