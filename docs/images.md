# Golden images

Every work machine boots from a golden image: a boxd snapshot named `<prefix>-<opencode version>-<size>` in the work's
region, such as `oc-golden-2.4.1-4x16`, that holds this machine's OpenCode and the guest helper, and nothing else. The
plugin builds these images itself, from a fixed recipe; you do not build one by hand.

- `boxd_ensure` builds the image it needs when it is missing (option `buildGolden: "auto"`, the default). A build for
  one region and size is shared by every call that needs it at once. With `buildGolden: "never"`, `boxd_ensure` answers
  `GOLDEN_MISSING` and names the `boxd_golden` call instead.
- `boxd_golden` builds, lists or prunes images. With no input it builds the default size in every region that lacks
  one; `region`, `size` and `from` choose; an image that exists answers `present` unless `rebuild: true`.
- The size comes from the image, so a work machine never needs a resize, and nothing reboots after a create.
- Snapshots do not cross regions, so each region has its own images.

## The recipe

1. **A builder machine**: `oc-gb-<region>-<size>-<rand>`, labelled `role=golden-builder`, with `--delete-after 2h` as
   a safety net, so it is removed even if this machine goes away. It starts from stock boxd, or from the `goldenBase`
   snapshot when one is set.
2. **One exec on the builder**: upgrade OpenCode to this machine's version (`opencode upgrade --major` from the stock
   1.x, then `opencode upgrade <version>`), check `opencode --version` and that the guest server asks for its password,
   install the guest helper in `~/.opencode-boxd/`, and run your `goldenSetup` script when one is set.
3. **The scrub**, the same whatever the base: stop `opencode serve`, and delete `/etc/profile.d/boxd-env.sh` (boxd writes
   it again at every boot), the guest password, the helper's exports, and `/home/boxd/work/`. The build refuses a base
   whose OpenCode database holds a session (`GOLDEN_BUILD_FAILED`: the base was a used machine, not an image) and a base
   that holds `~/.local/share/opencode/auth.json` (`GOLDEN_HAS_CREDENTIAL`, below).
4. **Save and remove**: `snapshots save` under the image's name in that region, then the builder is removed.

A build takes about one to two minutes. No step ever saves a work's machine as an image: a work's checkout, its session
database, its guest password and whatever its session wrote never reach another machine.

## Model credentials are never baked into an image

An image reaches every work created from it, and anyone in your boxd organisation who can boot it. A key stored in an
image could not be scoped or rotated per work, and would outlive its rotation in every image that holds it. So a build
refuses a base with an `auth.json`, whatever `goldenBase` says, with `GOLDEN_HAS_CREDENTIAL`.

Give works a model key in one of three ways, in this order:

1. **A sealed `boxd env` secret, bound to the provider's hosts** (recommended):

   ```sh
   boxd env set OPENCODE_API_KEY <key> --secret --domains <provider hosts> --scope private
   ```

   boxd injects it at every boot; the machine holds only a placeholder, and the real value is sent only to the
   provider's hosts. One rotation reaches every work.
2. **A separately named secret per provider or team**, such as `ANTHROPIC_API_KEY` for one and `OPENROUTER_API_KEY` for
   another, with each work's `model` choosing the provider.
3. **The provider's own sign-in on one machine**: a person runs `boxd connect oc-<work id>` and then
   `opencode auth login` there (it needs a login shell). The credential then lives on that work's disk only, and goes
   when the work is dropped.

Before a build, `boxd_golden` looks at the account's secrets. When none is one that OpenCode reads as a provider key, the
build still succeeds, but its result carries `warning: "NO_MODEL_CREDENTIAL"` with these three ways, and `boxd_status`
repeats it: the third way happens after the build. A work with no credential answers `GUEST_AUTH_FAILED` at its first
prompt, with the same next step.

A provider may refuse a service-account key (one answered 403 `provider.auth`); use a key made for this, with a spending
limit, and rotate it if anyone leaves the organisation.

## Your own customisation

- **`goldenSetup`**: an absolute path to a machine script, inside the project or an allowed root, that the builder runs
  before the scrub. Use it for tools, configuration or skills every work needs. It runs in every region the same way.
- **`goldenBase`**: a snapshot name to build from instead of stock, so a hand-made machine's customisations carry over.
  A base snapshot lives in one region only; `goldenSetup` is how the same customisation reaches the other region. The
  base is scrubbed like any other, and refused if it holds a session or an `auth.json`.

The builder's labels are captured into the image, and a restore inherits them under its own: works set `role=session`,
which overrides `role=golden-builder`. Anything else that selects machines by that label must know this.

## When this machine's OpenCode changes

An OpenCode upgrade here makes a new image name, so new works get the new image and open works keep the one they recorded.
`boxd_ensure` upgrades an open work's guest in place once its session is idle; until then the work stays usable for
reads and prompts, and a harvest answers `GUEST_VERSION`.

Images pile up, one per OpenCode version, size and region. `boxd_status({ include: ["images"] })` marks each one
`inUse` when an open work records it, and `boxd_golden({ prune: true })` removes the ones no open work records and that
are not the current version's. It never removes an image an open work records, because `boxd_resume` rebuilds from it.
