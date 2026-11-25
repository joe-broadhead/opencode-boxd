# Changelog

## 0.0.0 (unreleased)

The first release under `we-the-rebel-alliance`, rebuilt from `master` on OpenCode 2.4.1 and moving towards
plugin-contract v0.

- OpenCode 2.4.1 exactly: `@opencode/*` devDependencies are 2.4.1, the supported range is `>=2.4.1 <2.5.0`, and the
  plugin is tested on 2.4.1. Older hosts and their test matrices are gone; an unsupported host still gets a clean
  `HOST_UNTESTED` refusal, and the unsupported example is 2.5.0.
- The package is `@we-the-rebel-alliance/boxd-plugin` at `0.0.0`; every repository URL, install line and doc link
  points at the new org and `master`.
- `events_list` is a tool too (`boxd_events_list`): the `boxd.works` source's phase changes are readable without an RPC
  call, from the local ledger, with the same permission action.
- The skill is `boxd-sessions`, because the boxd machine ships its own `boxd` skill; its description and the namespace
  line are within the fixed-context budget.
- No per-request `context` or `compaction` hook: cost stays in `boxd_status` and a change reaches a session as a
  synthetic notice. The one session hook is the end-of-turn idle check.
- `boxd_drop` refuses with `UNPUSHED` while a local branch holds a commit that no remote ref contains, so a machine is
  never destroyed with commits that were never pushed. The harvest reports the count and the next step.
- The option `regions` is the placement allowlist: with `"regions": ["fra"]` no new work's machine or new golden image
  is made elsewhere, `auto` chooses only there, and any other region answers `REGION_NOT_ALLOWED`. It pins new placement
  only; a work that already lives in another region still converges, resumes and drops there, a resume rebuilds it in
  its own region (image included, unless `buildGolden` is "never") and a prune covers every region. `/boxd-status`
  shows the allowlist beside the default region.
- Text that meant the machine running OpenCode says "here" rather than "the laptop", since OpenCode may run on a boxd
  machine.
- The old design and legacy-declaration docs are gone; the README and `AGENTS.md` describe the current direction. The full
  docs set, the `capabilities` manifest and plugin-contract v0 arrive in the next phase.
