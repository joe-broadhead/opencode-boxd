# The golden image

Every machine the plugin creates boots from one snapshot: the golden image. It must contain the OpenCode version this
laptop runs, and a way for the session to reach a model. It must not contain a credential of its own if you can avoid it.

The stock boxd image does **not** contain OpenCode 2: a stock machine ships 1.19.5, which is a 1.x release and ignores
the guest server's password. Build your own once, and set the plugin's `snapshot` option to its name.

The default name is `opencode-golden`. `boxd_status` says when it is missing, and `boxd_ensure` and `boxd_resume` refuse
to create a machine without it.

## 1. A machine to build it on

Make a private machine from the stock image and open a shell on it. Do this with the `boxd` CLI, outside the plugin:

```sh
boxd machine new golden-builder --label role=image --json
boxd machine connect golden-builder
```

There is no stock snapshot to name: omit `--from-snapshot`, and `machine get` then reports `source: standalone`.
`machine connect` gives a real login shell; `boxd machine exec golden-builder -- bash` does not, and interactive
commands such as `opencode auth login` exit silently under it.

Set a short idle bound while the machine waits for you, so it does not bill:

```sh
boxd machine config set golden-builder auto-hibernate.timeout 1800
```

Do not pass `--shared`: sharing deletes OpenCode's sign-in. Do not pass `--isolated`: the image keeps git and the in-VM
`boxd` CLI, which a session machine needs.

## 2. The OpenCode version that matches the laptop

The guest must run exactly the version on this laptop. Print it on the laptop first:

```sh
opencode --version        # for example: opencode v2.2.5
```

The guest ships 1.x, so upgrade across the major version first, then pin the laptop's exact release:

```sh
opencode upgrade --major  # installs the newest 2.x, for example 2.2.6
opencode upgrade 2.2.5    # the exact version the laptop runs
opencode --version        # must equal the laptop's, to the patch release
```

`opencode upgrade 2.2.5` from 1.x refuses with "OpenCode 2.2.5 is OpenCode 2"; the `--major` step is what makes 2.x
reachable. Both steps together take a few seconds.

Check that the server password works, because the guest helper depends on it. Check both directions and stop the
server afterwards:

```sh
OPENCODE_PASSWORD=probe opencode serve --hostname 127.0.0.1 --port 4096 &
sleep 5
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4096/api/info                 # 401, not 200
curl -s -o /dev/null -w '%{http_code}\n' -u opencode:probe http://127.0.0.1:4096/api/info # 200
pkill -f "opencode serve"
```

A `200` without credentials means the server ignored the password: the image holds a 1.x OpenCode, and every session on
it would be open to anything that can reach the port. Leaving the test server running puts it inside the snapshot.

## 3. A way to reach a model

The recommended path keeps **no credential in the image**. A boxd environment variable is injected into every machine
at boot, so the image can stay clean:

```sh
boxd env set --secret OPENCODE_API_KEY <key> --domain '*.opencode.ai,opencode.ai'
```

- `--secret` seals the value: `boxd env list` shows `(sealed)`, never the value.
- Bind it to the provider's hosts with `--domain`, so the guest cannot send it anywhere else.
- Scope it to the org (default `all`) or to you (`private`); either is injected at boot by `boxd-takeoff` into
  `/etc/profile.d/boxd-env.sh`.
- The machine boots with the variable already set, `auth.json` stays absent, and every image you build inherits the
  arrangement without holding the key.

Two things to know:

- A **Go Teams service-account** key does not work for model calls. The guest answers
  `provider.auth … Go Teams covers workspace members, not service accounts. Use a personal API key to call Go models.`
  Use a personal provider key with a **spending limit**.
- The injected variables are readable by anything on the machine and by anyone who can boot a machine in the
  organisation: they are injected at boot, not baked into the image, but every boot has them. Rotate the key if someone
  leaves.

### Signing in on the machine, as a fallback

If you cannot use `boxd env`, sign the guest's OpenCode in **on the machine itself**:

```sh
ssh -t golden-builder.boxd opencode auth login
```

`ssh -t` (or `boxd machine connect` then `opencode auth login`) is required: `boxd machine exec --tty … -- opencode auth
login` exits with no picker. Never copy `~/.local/share/opencode/auth.json` from the laptop, and never paste a token into
a prompt: an agent's transcript would hold it. Confirm without printing the secret:

```sh
ssh -t golden-builder.boxd opencode auth list
```

`auth list` already names providers that come from environment variables, so look for the provider you added with a
stored credential, not for a longer list.

A credential stored this way is on the image's disk. Anyone in the organisation who can boot the image inherits it: use a
dedicated key with a spending limit, and rotate it when someone leaves. This is why the environment path is preferred.

## 4. Remove the injected values before you save

`boxd-takeoff` writes the environment variables to `/etc/profile.d/boxd-env.sh` on the machine's disk. Delete that file
just before the snapshot, so the image carries no copy; it is regenerated from `boxd env` at the next boot:

```sh
sudo rm -f /etc/profile.d/boxd-env.sh
```

Clear any shell history too. Leave nothing else changed.

## 5. Save it

Nothing may be running that holds a session you care about, and the machine should be clean of scratch work.

```sh
boxd snapshots save golden-builder opencode-golden --json     # a few seconds for a ~10 GiB disk, an image either way
boxd snapshots list --json                                    # the name, status "ready", version 1
boxd machine remove golden-builder -y
```

Point the plugin at it in `opencode.json` (or rely on the default name):

```jsonc
{
  "plugins": [{
    "package": "github:joe-broadhead/opencode-boxd#v0.0.0",
    "options": { "snapshot": "opencode-golden" }
  }]
}
```

`boxd_status` shows `Snapshot: opencode-golden (present)`. A name that is not there shows `(not in this boxd account)`,
with this doc as its next step.

## The disclosure

**A snapshot that holds model credentials can be booted by anyone in your boxd organisation who can see or use
snapshots.** A credential stored on the disk is inherited by every machine created from it. The environment path keeps
the value out of the image, but every boot still has it. Treat either arrangement as a shared secret:

- use a provider key made for the image, with a spending limit, and rotate it if anyone leaves the organisation;
- do not put personal tokens, mail credentials or a second provider on the image;
- delete an old image when you replace it (`boxd snapshots remove <name> -y`), so the old arrangement cannot be booted.

The plugin itself never copies credentials to or from a machine, and never reads your laptop's credential store.

## Rebuilding it when the laptop's OpenCode changes

`GUEST_VERSION` means the machine's OpenCode is not this laptop's, and `boxd_status` shows the version the guest must
have. When you upgrade OpenCode on the laptop:

1. build a new image as above, with the new version, and a new name, such as `opencode-golden-2.2.7`;
2. set `snapshot` to the new name;
3. run `boxd_resume` for each open work: a machine that is gone is rebuilt from the new image and its proven transcript;
4. delete the old image once no work needs it.

A snapshot is an image, not a session: rebuilding it never carries a transcript. The laptop's ledger does.
