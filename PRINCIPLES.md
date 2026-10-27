<!-- doc-id: principles -->
# Principles

[한국어](PRINCIPLES.ko.md)

These are the working principles of every polyspec repository. kit vendors this file byte for byte to each repository that
takes its tools, so each repository holds the same text and `make kit-check` fails on a difference. A repository's
AGENTS.md links here and states only the rules of its own. The principles come from the owner; a principle is changed only
in kit, with its grounding.

## Responsibility

- P1 Everything is the responsibility of whoever works on it: the code, its tests, its documents, AGENTS and the memory. A task
  is not done while one of them is missing.
  Enforced by: `make commits-check`, `make docs-check`
- P2 A rule is followed because it is right, never because it exists. "It was there before" is no ground. A rule, a code path
  or a document found wrong is reported and corrected; a found oddity is reported at once, with the question whether a rule
  must be made or corrected, and it is fixed or confirmed convincingly before the work moves on.
  Enforced by: none, whether a rule is right and an oddity was reported is a judgement that no tool makes.
- P3 Rules first: development states logical rules and keeps them. Behaviour that follows no stated rule is a defect. When no
  rule exists for what the work needs, the rule is made, never skipped.
  Enforced by: `make rules-check`
- P4 A settled ruling is written into its specification, with its grounding, before work that depends on it. A ruling that
  lives only in a conversation, a commit message or an agent's report is not settled.
  Enforced by: none, no tool sees whether a ruling lives only in a conversation.
- P5 A wrong change is judged by its harm and its correctness, not by its intent. A harmful change is reverted at once; a
  harmless change that is wrong or unneeded is removed; a correct change unrelated to the work is kept and committed on
  its own with its real reason, never recorded as part of the work it did not belong to.
  Enforced by: `make commits-check`

## Standards

- P6 A standard is never lowered because it is hard to meet; lowering it while testing is betrayal of the standard. A standard
  that is wrong is raised as a problem and corrected, with the reason.
  Enforced by: `make test-markers-check`
- P7 No tricks, in any case. A goal reached by an abnormal method is not reached. When a requirement can be met only by a
  trick, that is stated exactly instead of done.
  Enforced by: `.claude/settings.json`
- P8 Errors are never hidden: no fallback that turns a wrong input into a plausible one, no silent drop of an input or an
  output, no swallowed error. A fallback stands only where it is truly needed, with that need stated.
  Enforced by: `make lint-ts`, `make lint-python`, `make lint-go`, `make lint-php`, `make lint-rust`, `make suppression-check`
- P9 Correct first; fast only when it stays correct.
  Enforced by: none, the order of correctness and speed is a judgement.
- P10 Work reaches main in one of two ways. Direct work on main is committed through the gated commits of P38. Parallel or
  isolated work has its own worktree and branch, named `{type}/{shortname}-{checklist id}` and `{project}-{shortname}-{checklist id}`,
  made by `make worktree-setup`; it reaches main only by the fast-forward of `make land`,
  and `make land` removes its worktree and branch right after the merge unless `config/retained-branches.json` pins that exact
  local branch and full commit for an intentional cancellation backup. A record states its reason and removal condition; cleanup
  rejects a moved local ref and preserves a matching branch and worktree. Test or experiment code that cannot merge is
  cherry-picked when it is worth keeping and otherwise discarded, always before the commit; when it cannot be removed at once, a
  checklist sub-item states the condition of its removal.
  Enforced by: `.githooks/pre-push`, `.githooks/pre-merge-commit`
- P11 Code comments, identifiers, logs, error messages, test names and commit messages are written in English. Documents are
  English, each with a Korean twin that writes technical terms in English.
  Enforced by: `make commits-check` for the commit messages, `make language-check` for the code

## Design

- P12 No backward compatibility before a release says otherwise: an old path is removed, never kept behind a compatibility
  layer, a fallback or a migration.
  Enforced by: none, whether a path is kept for compatibility is a design judgement.
- P13 The simplest implementation that fully meets the current requirements: no abstraction, setting or indirection for an
  uncertain future.
  Enforced by: `make lint-ts`, `make lint-python`, `make lint-go`
- P14 What an outside ecosystem already provides is used as it is, never redeveloped: its standard tool, library or protocol.
  Enforced by: `make rebuild-check`
- P15 Components are modular, each concern clearly separated.
  Enforced by: `make duplication-check`
- P16 Architecture is decided for the long term: a stopgap that works now and must be replaced later is not accepted. A
  problem is never solved by creating another problem.
  Enforced by: none, whether a measure is a stopgap is a design judgement.
- P17 Recovery, apply and transformation are idempotent; a change is published as an event, never found by polling; paths are
  resolved declaratively from a declared root; and multi-platform is a hard requirement, met without platform tricks.
  Enforced by: `.claude/settings.json`
- P18 No script polls in a loop with no known end: no `until` or `while` with a sleep, no loop around `gh run list`, no
  watchdog. A wait is one command that its own work bounds, such as `gh run watch <id> --exit-status`, a background
  command whose completion is notified, or a message from the session that does the work.
  Enforced by: `.claude/settings.json`

## Verification

- P19 A defect starts as a test that reproduces it and fails for the intended reason; the fix follows; the same test passes.
  A test that cannot fail proves nothing, and a test that passes without running is a defect.
  A comment or document that a change makes stale is corrected in the commit of that change; one found after its row is done
  is a sub-item whose Verification is `make text-absent FILE=<path> TEXT=<stale text>`, which fails while the stale text is there.
  Enforced by: `make commits-check`
- P20 An item is completed by its own unit tests: red, implementation, green. Only the checks that own what changed run; the
  full suite is not run, neither per fix, per item nor at the end. The full suite runs only on the order of the conductor,
  which the Claude Code hook in `.claude/settings.json` enforces.
  Enforced by: `.claude/settings.json`
- P21 A hard judgement or a new line of reasoning is verified adversarially, in rounds, until a round finds nothing. The scope
  of the review is fixed before the first round; a question beside it becomes its own item. The review is asked for
  solutions as well as objections, and a finding counts only when it shows a proposition wrong, shows it contradicted by
  another document, or shows a case missing that the proposition claims to cover.
  Enforced by: none, an adversarial review is a judgement.
- P22 Work handed to an agent carries everything the one handing it knows: the history, why earlier attempts were wrong, the
  measurements, these principles, the state of shared resources and the completion conditions. Subagents run on Haiku 5.5,
  and each gets one row at a time, with its files, its owner test and its stop condition. The agent first answers
  how it will judge right and wrong; the two agree before the work starts. An agent's report that something does not exist,
  is impossible or does not apply is checked in the code before it is accepted. The result of an agent is verified before
  it lands.
  Enforced by: none, what an agent is told is a judgement of the one who hands it the work.

## Questions

- P23 A question is asked only when it is needed: not already decided or evident, not asked by habit, not a way to leave
  something out, never confusing; and a needed question is never left out. A decision that a new milestone reopens is
  asked again.
  Enforced by: none, whether a question is needed is a judgement.

## Workflow

The rules of work that every repository follows, stated once here (K243); an AGENTS.md holds only the rules of its own
repository.

- P24 A plan is the folder `docs/plans/<plan>/` with `plan.md`, `checklist.md` and their Korean twins. A checklist is one table
  with the columns ID, Task, Deliverables, Verification and State; an item ID is unique among the checklists, and a
  sub-item `<id>-<n>` follows its item in one plan. `make plan-new` and `make item-new` write them, and `make plan-split` moves items to another plan.
  A change starts from its registered row: `make item-new` registers the row before any work, and its commit names the row
  (P28).
  Enforced by: `make docs-check`, `make commits-check`
- P25 An item is `[ ]` waiting, `[~]` active, `[v]` verification, `[o]` done, `[!] cause: <cause>; retry: <condition>` bypassed or
  `[-] cause: <cause>` impossible, and moves only along the transitions of `make item-state`. Verification means the implementation is
  committed and its declared unit tests passed. It permits a push, but blocks tag creation and release until it is done; a failed
  verification returns it to active. A new finding on a done item is a sub-item of its own; the done item keeps its state.
  Enforced by: `make docs-check`, `make commits-check`
- P26 An open item names, in its Verification cell, the commands of its own unit tests; no item is verified by a suite. A suite runs in CI, or once as an explicit final verification after all checklist
  items are terminal. `make item-test` runs the commands.
  Enforced by: `make docs-check`, `.claude/settings.json`
- P27 A commit completes at most one item: it moves at most one state, and the commit that moves an item to done records it in
  CHANGELOG.md and its Korean twin. The uncommitted work is at most one item.
  Enforced by: `make commits-check`
- P28 A commit message is `type(scope): Subject (#id)` with a type of feat, fix, docs, style, refactor, test or chore, a Subject
  of at most 50 characters that starts with a capital letter and ends without a period, a blank line and a body wrapped at
  72 characters, with no footer of an AI tool: no co-author or session trailer of one. Its author and committer are a
  person, never an AI tool. `make commit` writes it.
  Enforced by: `make commits-check`
- P29 The make targets of a task have fixed names: `install`, `build`, `test`, `lint`, `docs-check`, and `build-<runtime>`,
  `test-<runtime>` and `lint-<runtime>` for each runtime of `packages/`, all defined by kit. A repository joins a task by a
  prerequisite of its own, such as `build: kit-build`, never by another target that starts with a task's name (K246).
  Enforced by: `make kit-check`
- P30 During 0.0.x development, applications connect declared local provider sources through native package-manager
  mechanisms. The package manager owns links, installed records, dependency resolution and generated metadata; a source
  is not disguised as an installed released version. Applications own compatible native development declarations and
  locks. Release declarations and locks remain records of released dependencies; kit does not synthesize link manifests,
  version aliases or lock metadata, and no tracked lock waits for a coordinated batch.
  Enforced by: `make link-state-check`
- P31 No gate is bypassed: a test, script or Makefile never sets the CI identity (`GITHUB_ACTIONS`, `CI`) outside a workflow, never
  names a gate of kit-gates in `make -o`, `--old-file` or `--assume-old`, and never uses `--no-verify` (K308).
  Enforced by: `make bypass-check`
- P32 Scope: shared contract behaviour exists in every implementation (S6, S10), implemented with its tests. A language- or
  runtime-native integration is written once as a neutral rule in docs/spec, and each applicable implementation binds its native form
  to it. A component- or artifact-specific requirement is tested only by a feature unit whose owner resolves from an existing
  coverage part or released package; an unscoped unit still applies to every implementation. An implementation-internal test is a
  plain test of its package, not a parity unit, and it cites no requirement; a symbol that is public by accident becomes non-public.
  Enforced by: `make parity-declarations-check`, `make parity-check`, `make divergence-check`, `make test-markers-check`
- P33 A rule that the work needs and docs/spec lacks is written in docs/spec first. A requirement is cited only by a test that
  tests it, a unit is never dropped to pass, and nothing is renamed to escape a check.
  Enforced by: `make parity-declarations-check`
- P34 Repeated code is fixed by restructuring it into one module, never by excluding it; a tool source is classified; generated
  output is never tracked in Git.
  Enforced by: `make duplication-check`, `make rebuild-check`, `.githooks/pre-commit`
- P35 Local source development does not wait for a provider release. Missing native source connections are reported as
  kit defects with their file and line; incompatible dependency requirements are corrected in the application's native
  declarations. Release installs use the exact released graph of their locks, independently of development source state.
  Enforced by: none, whether a finding is a link defect or an application declaration issue requires review.
- P36 No deferral: a defect that is found is registered as a row and worked now, never left for later.
  Enforced by: none, whether a found defect is worked now is a judgement of the one who found it.
- P37 A result is reported only after its check has run, with the output of that run. A claim that a check passes, made
  without its output, is not a result.
  Enforced by: none, whether a result was checked before it was claimed is a judgement.
- P38 main may be written directly, by one actor per checkout, through gated commits. A commit on main runs the gates that
  `make land` selects for its staged paths, on the staged tree, and is refused only on a finding that HEAD lacks, which it names.
  A merge commit on main is refused, so main moves by commits and fast-forwards only. The first commit of a repository, which
  creates main with no commit to compare with, is not gated. The hooks protect against an accidental ungated commit; a deliberate
  bypass (`--no-verify`, `core.hooksPath`, a raw `update-ref`) is out of scope (K404, K446, K404-1).
  Enforced by: `.githooks/pre-commit`, `.githooks/pre-merge-commit`

## Repository standards

The owner approved these standards on 2026-10-13. Each is enforced by a tool that fails on a violation; the tools, their
order and the predicted failures are in [the standards enforcement plan](https://github.com/polyspec/kit/blob/main/docs/plans/standards-enforcement/plan.md), which stays in kit. Until its
tool lands, a standard binds the work as written here.

- S1 No rebuilds: follow each ecosystem's rules and use its tools and libraries as they are. Our own rules govern only
  what we create and never block an outside tool's behavior, such as the links npm creates. Our own implementation of
  something an ecosystem could provide needs a rebuild record (`docs/rebuild/<tool>.md`): the requirement, the tools searched and
  why none fits.
  Enforced by: `make rebuild-check`
- S2 PHP: one class per file; PSR-4 for the package and `autoload-dev` for tests; no `classmap`; `files` only for
  namespaced functions and constants; no `spl_autoload_register` and no runtime `ClassLoader` registration; generated code
  follows PSR-1 and PSR-4; tests run on PHPUnit.
  Enforced by: `make lint-php`
- S3 Tests run only on the ecosystem's standard runner (`node --test` or vitest, PHPUnit, `go test`, `cargo test` or
  nextest, unittest), with no runner protocol, `check()` helper or file chain of our own, and against installed packages:
  no `PYTHONPATH`, no `sys.path` change, no path that leaves the repository. kit fixes the test files of each runner
  (`*.test.{ts,mts,cts,mjs,cjs,js}`, vitest's `*.{test,spec}.*`, `*Test.php`, `*_test.go`, `tests/` and `#[test]`,
  `test_*.py`); a repository may add files but never narrow the set, and a file named like a test is run by a binding.
  Enforced by: `make parity-declarations-check`
- S4 Versions: kit enforces no version or pin; each package manager and its lock decide.
  Enforced by: `make toolchain-check`, `make dependency-policy-check`
- S5 Folders: every monorepo has the same root folders (`packages/`, `contracts/`, `docs/`, `scripts/`, `tests/`,
  `examples/`, `benchmarks/`, `config/`). Runtime ports of the main spec live in `packages/<runtime>/`, other components in
  `packages/<component>/` and their ports in `packages/<component>/<runtime>/`; folder names carry no repository prefix. A
  runtime folder names the language of its sources (TypeScript in `ts`), a folder of tests is `tests/`, AGENTS, CHANGELOG
  and Makefile lie at the root, and `docs/` holds `spec/`, `operations/`, `plans/`, `rebuild/`, `features.md` and the files
  of a VitePress site (K245). `make layout-check` checks it with alint against `config/layout.yml`, the map of the repository over kit's common rules;
  each exception there carries its reason.
  Enforced by: `make layout-check`
- S6 Language parity: every implementation of a repository tests the same shared feature units, vectors and API at the same
  level, and each requirement that docs/spec defines (a list item, bulleted or numbered, `**<id>**` or a heading `<id>`) is cited by a unit.
  An unscoped unit binds every implementation. A component- or artifact-specific requirement may scope a feature unit only to one owner
  derived from a coverage part in `contracts/features.json` or a package in `config/release.json`, or to an explicit nonempty set of
  coverage-part owners of one feature; every resolved implementation has its own native binding, the requirement names each owner or an
  implementation whose tests it explicitly shares, and each native test names the requirement. A free-form profile, implementation
  allow-list, exclusion or native-only symbol is not scope.
  A case of a directory suite lists the requirements it tests in its `case.json`.
  Enforced by: `make parity-declarations-check`, `make parity-check`
- S7 Test placement: a test of a basic feature lives in the package and repository that own the feature; a consumer keeps
  only tests from the consumer's point of view.
  Enforced by: `make layout-check`, `make parity-declarations-check`
- S8 Reporting oddities is the second bullet of "Responsibility"; no tool can enforce it. What S8 adds: every exception,
  profile and rebuild record carries its reason, in the place where it is declared.
  Enforced by: `make rebuild-check`, `make dependency-policy-check`
- S9 Cross-language orchestration and checks, kit included, are written in TypeScript, checked by `tsc` with
  `erasableSyntaxOnly`. Exceptions: a harness that drives one language's implementation is a test of that language; a
  language-specific static check is a plugin of that ecosystem's analyzer; a symbol extractor runs that ecosystem's tool.
  Enforced by: `make layout-check`
- S10 PHP extension: a PHP extension implements every PHP library of its repository and registers their classes and functions
  under the same names and signatures. A library is `packages/php` named `polyspec/<repository>`, or `packages/<component>/php`
  named `polyspec/<repository>-<component>` for each component; the repository has one extension. It lies in
  `packages/php-ext/` with its sources in `src/` and one stub, `src/polyspec_<repository>.stub.php`; it is named
  `polyspec/<repository>-php-ext` and `polyspec_<repository>`, a hyphen of the repository name an underscore. `make
  build-php-ext` builds it with phpize after checking that the stub hash of its arginfo header, which `make
  php-ext-arginfo` writes with the gen_stub.php of the PHP, is that of the stub, in a copy that keeps `composer.json` beside
  `src/`, so that `config.m4` takes the version of the extension from `../composer.json`; `make test-php-ext` compares by
  Reflection what it registers with the libraries, each name with the library that declares it, before its unit tests, which
  are the PHPUnit files of every library run with the extension loaded and none of the sources of the library (its dependencies and
  autoload-dev are loaded, its own autoload is not, so the library has no guard against the extension), and those of `packages/php-ext` when it holds any; its
  parity implementation shares the tests of the libraries by this layout, with no relative path in a configuration.
  The PHP library is library code only: an application on a userland framework, such as a PHP console application, is its own
  Composer package that requires the library, since an internal class cannot extend a userland class. A Composer package of
  type `project` is an application: it is outside the extension run and the S10 library checks, and `make test-php` runs its
  tests as its own package.
  Enforced by: `make lint-php-ext`, `make test-php-ext`, `make layout-check`, `make dependency-policy-check`
