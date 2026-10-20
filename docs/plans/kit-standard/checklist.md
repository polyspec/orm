<!-- doc-id: checklist-kit-standard -->
# Kit standard checklist

| ID | Task | Deliverables | Verification | State |
|---|---|---|---|---|
| KSTD | The repository follows the kit standard 0.0.54 | the layout, plans, pins and lint fixes of the rollout | `make layout-check`, `make lint-ts` | [!] cause: the parity, docs and Go lint items of this plan wait on CI runs; retry: after the items of this plan are done in turn |
| KSTD-2 | Every unit of config/parity.json holds in every implementation and cites the spec requirements its tests name (kit K273, K275, K276) | config/parity.json, docs/spec, the tests of every implementation | `make parity-declarations-check` | [~] |
| KSTD-2-2 | The documents count and list the PHP extension as an implementation (follows KSTD-2). Cause: with the implementations of config/parity.json as the language set, docs-rules-check reports 69 docs.implementation-count findings: 43 sentences that count N clients, 13 tables without a PHP extension column, 11 enumerated sets, and section 4 of protocol.md and protocol.ko.md without a PHP extension row | docs/spec, docs/operations and their Korean twins | `make docs-rules-check` | [ ] |
