<!-- doc-id: principles -->
# Principles

[한국어](PRINCIPLES.ko.md)

These are the working principles of every polyspec repository. kit vendors this file byte for byte to each repository that
takes its tools, so each repository holds the same text and `make kit-check` fails on a difference. A repository's
AGENTS.md links here and states only the rules of its own. The principles come from the owner; a principle is changed only
in kit, with its grounding.

## Responsibility

- Everything is the responsibility of whoever works on it: the code, its tests, its documents, AGENTS and the memory. A task
  is not done while one of them is missing.
- A rule is followed because it is right, never because it exists. "It was there before" is no ground. A rule, a code path
  or a document found wrong is reported and corrected; a found oddity is reported at once, with the question whether a rule
  must be made or corrected, and it is fixed or confirmed convincingly before the work moves on.
- Rules first: development states logical rules and keeps them. Behaviour that follows no stated rule is a defect. When no
  rule exists for what the work needs, the rule is made, never skipped.
- A settled ruling is written into its specification, with its grounding, before work that depends on it. A ruling that
  lives only in a conversation, a commit message or an agent's report is not settled.
- A wrong change is judged by its harm and its correctness, not by its intent. A harmful change is reverted at once; a
  harmless change that is wrong or unneeded is removed; a correct change unrelated to the work is kept and committed on
  its own with its real reason, never recorded as part of the work it did not belong to.

## Standards

- A standard is never lowered because it is hard to meet; lowering it while testing is betrayal of the standard. A standard
  that is wrong is raised as a problem and corrected, with the reason.
- No tricks, in any case. A goal reached by an abnormal method is not reached. When a requirement can be met only by a
  trick, that is stated exactly instead of done.
- Errors are never hidden: no fallback that turns a wrong input into a plausible one, no silent drop of an input or an
  output, no swallowed error. A fallback stands only where it is truly needed, with that need stated.
- Correct first; fast only when it stays correct.
- Work may go straight to main. A branch or worktree, when an agent or the situation needs one, is named
  `{type}/{shortname}-{checklist id}` and `{project}-{shortname}-{checklist id}`, and is deleted as soon as it is merged
  into main. Test or experiment code that cannot merge is cherry-picked when it is worth keeping and otherwise discarded,
  always before the commit; when it cannot be removed at once, a checklist sub-item states the condition of its removal.

## Design

- No backward compatibility before a release says otherwise: an old path is removed, never kept behind a compatibility
  layer, a fallback or a migration.
- The simplest implementation that fully meets the current requirements: no abstraction, setting or indirection for an
  uncertain future.
- What an outside ecosystem already provides is used as it is, never redeveloped: its standard tool, library or protocol.
- Components are modular, each concern clearly separated.
- Architecture is decided for the long term: a stopgap that works now and must be replaced later is not accepted. A
  problem is never solved by creating another problem.
- Recovery, apply and transformation are idempotent; a change is published as an event, never found by polling; paths are
  resolved declaratively from a declared root; and multi-platform is a hard requirement, met without platform tricks.

## Verification

- A defect starts as a test that reproduces it and fails for the intended reason; the fix follows; the same test passes.
  A test that cannot fail proves nothing, and a test that passes without running is a defect.
- While an item is developed, only the checks that own what changed run. The full suite runs exactly once, when every
  item of the active checklist is complete: never per fix and never per item.
- A hard judgement or a new line of reasoning is verified adversarially, in rounds, until a round finds nothing. The scope
  of the review is fixed before the first round; a question beside it becomes its own item. The review is asked for
  solutions as well as objections, and a finding counts only when it shows a proposition wrong, shows it contradicted by
  another document, or shows a case missing that the proposition claims to cover.
- Work handed to an agent carries everything the one handing it knows: the history, why earlier attempts were wrong, the
  measurements, these principles, the state of shared resources and the completion conditions. The agent first answers
  how it will judge right and wrong; the two agree before the work starts. An agent's report that something does not exist,
  is impossible or does not apply is checked in the code before it is accepted.

## Questions

- A question is asked only when it is needed: not already decided or evident, not asked by habit, not a way to leave
  something out, never confusing; and a needed question is never left out. A decision that a new milestone reopens is
  asked again.

## Repository standards

The owner approved these standards on 2026-10-13. Each is enforced by a tool that fails on a violation; the tools, their
order and the predicted failures are in [the standards enforcement plan](https://github.com/polyspec/kit/blob/main/docs/plans/standards-enforcement.md), which stays in kit. Until its
tool lands, a standard binds the work as written here.

- S1 No rebuilds: follow each ecosystem's rules and use its tools and libraries as they are. Our own rules govern only
  what we create and never block an outside tool's behavior, such as the links npm creates. Our own implementation of
  something an ecosystem could provide needs a rebuild record (`docs/rebuild/<tool>.md`): the requirement, the tools searched and
  why none fits.
- S2 PHP: one class per file; PSR-4 for the package and `autoload-dev` for tests; no `classmap`; `files` only for
  namespaced functions and constants; no `spl_autoload_register` and no runtime `ClassLoader` registration; generated code
  follows PSR-1 and PSR-4; tests run on PHPUnit.
- S3 Tests run only on the ecosystem's standard runner (`node --test` or vitest, PHPUnit, `go test`, `cargo test` or
  nextest, unittest), with no runner protocol, `check()` helper or file chain of our own, and against installed packages:
  no `PYTHONPATH`, no `sys.path` change, no path that leaves the repository.
- S4 Versions: a version is chosen only after every locked dependency is shown to work with it; the latest LTS where the
  ecosystem has one, otherwise the latest stable release the dependencies support, or a newer non-LTS close to the LTS.
  The declared floor equals the pinned toolchain at the pin's precision, every repository uses the same pins, an exception
  is declared with its scope, reason and retry condition, and nothing falls back silently to a source build.
- S5 Folders: every monorepo has the same root folders (`packages/`, `contracts/`, `docs/`, `scripts/`, `tests/`,
  `examples/`, `benchmarks/`, `config/`). Runtime ports of the main spec live in `packages/<runtime>/`, other components in
  `packages/<component>/` and their ports in `packages/<component>/<runtime>/`; folder names carry no repository prefix.
- S6 Language parity: every implementation of a repository tests the same feature units, vectors and API at the same
  level. A permanent difference is a declared profile whose reason cites a spec anchor; an exclusion is debt that fails
  until removed.
- S7 Test placement: a test of a basic feature lives in the package and repository that own the feature; a consumer keeps
  only tests from the consumer's point of view.
- S8 Reporting oddities is the second bullet of "Responsibility"; no tool can enforce it. What S8 adds: every exception,
  profile and rebuild record carries its reason and the owner's required review.
- S9 Cross-language orchestration and checks, kit included, are written in TypeScript, checked by `tsc` with
  `erasableSyntaxOnly`. Exceptions: a harness that drives one language's implementation is a test of that language; a
  language-specific static check is a plugin of that ecosystem's analyzer; a symbol extractor runs that ecosystem's tool.
