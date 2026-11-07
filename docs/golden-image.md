# The golden image

Every machine the plugin creates boots from one snapshot: the golden image. It must contain the OpenCode version this
laptop runs, a model provider the session can use, and nothing else that matters.

The stock boxd image does **not** contain it: a stock machine ships OpenCode 1.19.5, which is a 1.x release and ignores
the guest server's password. Build your own once, and set the plugin's `snapshot` option to its name.

The default name is `opencode-golden`. `boxd_status` says when it is missing, and `boxd_ensure` and `boxd_resume` refuse
to create a machine without it.

## 1. A machine to build it on

Make a private machine from a stock image and open a shell on it. Do this with the `boxd` CLI, outside the plugin:

```sh
boxd machine new golden-builder --from-snapshot <a stock image> --label role=image --json
boxd machine exec golden-builder -- bash
```

Do not pass `--shared`: sharing deletes OpenCode's sign-in. Do not pass `--isolated`: the image keeps git and the in-VM
`boxd` CLI, which a session machine needs.

## 2. The OpenCode version that matches the laptop

The guest must run exactly the version on this laptop. Print it on the laptop with `opencode --version`; the guest
ships 1.19.5, so upgrade across the major version first, then pin:

```sh
opencode upgrade --major    # installs the newest 2.x
opencode upgrade 2.2.6      # then the exact version this laptop runs
opencode --version          # must equal the laptop's, to the patch release
```

`opencode upgrade 2.2.6` from 1.x refuses with "OpenCode 2.2.6 is OpenCode 2"; the `--major` step is what makes 2.x
reachable. Both steps together take a few seconds.

Check that the server password works, because the guest helper depends on it:

```sh
OPENCODE_PASSWORD=probe opencode serve --hostname 127.0.0.1 --port 4096 &
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4096/api/info   # 401, not 200
```

A `200` means the server ignored the password: the image holds a 1.x OpenCode, and every session on it would be open to
anything that can reach the port.

## 3. A model provider, signed in on the machine

Sign the guest's OpenCode in **on the machine itself**. Never copy `~/.local/share/opencode/auth.json` (or any other
credential file) from the laptop, and never paste a token into a prompt: an agent's transcript would hold it.

```sh
opencode auth login        # choose the provider, finish the browser or key flow on the machine
opencode models | head     # the provider is listed
```

Where the machine has no browser, use the provider's device or key flow through `opencode auth login` on that machine.

A dedicated provider key for this image, with a spending limit, is the safe choice: everything an image can reach is
reachable by anyone who can boot it.

## 4. Save it

Nothing may be running that holds a session you care about, and the machine should be clean of scratch work.

```sh
boxd snapshots save golden-builder opencode-golden --json     # 2 s for a 9 GiB disk
boxd snapshots list --json                                    # the name, status "ready", version 1
boxd machine remove golden-builder -y
```

Then point the plugin at it, in `opencode.json`:

```jsonc
{
  "plugins": [{
    "package": "@joe-broadhead/opencode-boxd",
    "options": { "snapshot": "opencode-golden" }
  }]
}
```

`boxd_status` shows `Snapshot: opencode-golden (present)`. A name that is not there shows `(not in this boxd account)`,
with the doc as its next step.

## The disclosure

**A snapshot that holds model credentials can be booted by anyone in your boxd organisation who can see or use
snapshots.** The credentials live on the image's disk, and a machine created from it inherits them. That is how the
plugin's sessions reach a model without copying your laptop's credentials. Treat the image as a shared secret:

- use a provider key made for the image, with a spending limit, and rotate it if anyone leaves the organisation;
- do not put personal tokens, mail credentials or a second provider on the image;
- delete an old image when you replace it (`boxd snapshots remove <name> -y`), so the old key cannot be booted.

The plugin itself never copies credentials to or from a machine, and never reads your laptop's credential store.

## Rebuilding it when the laptop's OpenCode changes

`GUEST_VERSION` means the machine's OpenCode is not this laptop's, and `boxd_status` shows the version the guest must
have. When you upgrade OpenCode on the laptop:

1. build a new image as above, with the new version, and a new name, such as `opencode-golden-2.2.7`;
2. set `snapshot` to the new name;
3. run `boxd_resume` for each open work: a machine that is gone is rebuilt from the new image and its proven transcript;
4. delete the old image once no work needs it.

A snapshot is an image, not a session: rebuilding it never carries a transcript. The laptop's ledger does.
