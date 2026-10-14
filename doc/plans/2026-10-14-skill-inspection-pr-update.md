# Skill inspection PR update

Date: 2026-10-14
PR: https://github.com/NotoriousPOG/paperclip/pull/1
Base: `1e731520b` on the fork's `master`.

## Requirements

Update the existing PR, resolve its conflicts, and explain the security problem
with dated primary sources. Keep the optional SkillSpector integration. Do not
add a package dependency or change agent execution permissions in this PR.

Configured inspection must run before new or refreshed content is published.
Cover source creation, selection, manual and automatic refresh, repository
packages, and workspace scans. Holds retain existing installed versions. Only
an authenticated board actor can override a scanner hold. Existing platform
safety checks and company policies remain authoritative.

## Evidence and limits

- [Snyk ToxicSkills](https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/),
  published 2026-02-05, documents malicious instructions, credential theft,
  malicious downloads, and backdoors. The study is evidence of the attack class,
  not proof of a Paperclip exploit.
- The current base uses a finite set of deterministic content checks. It has
  company and skill access checks. Local runtime confinement is configurable.
  The PR description must link exact base code and distinguish content
  inspection from runtime and resource authorization.
- Static inspection can miss attacks and flag legitimate content. An operator
  override deliberately accepts that risk. This work does not establish complete
  team compromise, close the separate permissions feature, or isolate runners.

## Phases and exit criteria

1. Merge the current fork base without losing the original feature commit.
   Exit: no unresolved merge markers and a focused diff against the base.
2. Move source and workspace refresh inspection before publication.
   Exit: regressions prove a hold leaves installed bytes and versions unchanged,
   agent overrides are denied, and automatic refresh cannot override.
3. Validate the changes and update the template-based PR description.
   Exit: focused checks and the relevant final gates are recorded, with any
   unavailable or failed checks stated explicitly. Push without rewriting history.

## Validation

Run inspector, source persistence, route, workspace scan, and UI hold tests first.
Then run workspace typecheck, `pnpm test:run`, `pnpm build`, token gates, and map
checks when their entries change. Real-scanner corpus qualification is separate
from tests that use a stub scanner; record its availability honestly.

Rollback is a revert of this PR's feature changes. Disabling an optional scanner
removes its review gate; built-in checks remain. A configured but broken scanner
must produce a hold.

## Status

- Base merge completed in `805c868c6`; seven conflicts were resolved.
- Enforcement is implemented. All 152 focused tests across eight files passed.
  Build, typecheck, token gates, map checks, and the 22-sample real-scanner corpus
  passed. Server and UI builds and UI typecheck also passed after the final fix.
- Final review staged admitted local package inventories so an unrelated
  project-root file or symlink cannot enter scanner input. The regression failed
  before this fix and passed afterward.
- The full repository run is in progress. Five workspace provisioning failures
  and one heartbeat cancellation failure reproduced on the unchanged base
  `1e731520b`. The full gate is not claimed green.
- GitHub Dependency Review reports that the fork does not support the feature;
  remote checks are not claimed green.
