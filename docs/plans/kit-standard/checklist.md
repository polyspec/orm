<!-- doc-id: checklist-kit-standard -->
# Kit standard checklist

| ID | Task | Deliverables | Verification | State |
|---|---|---|---|---|
| KSTD | The repository follows the kit standard 0.0.54 | the layout, plans, pins and lint fixes of the rollout | `make layout-check`, `make lint-ts` | [!] cause: the parity, docs and Go lint items of this plan wait on CI runs; retry: after the items of this plan are done in turn |
| KSTD-2 | Every unit of config/parity.json holds in every implementation and cites the spec requirements its tests name (kit K273, K275, K276) | config/parity.json, docs/spec, the tests of every implementation | `make parity-declarations-check` | [!] cause: the declaration still holds profiles, native-only symbols or exclusions, or units without named requirements; each missing feature and test of each implementation is to be written red-first; retry: after kit 0.0.55 is installed with make kit-sync |
