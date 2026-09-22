# Releasing the menubar app

## Cutting a release — merge the release PR

`.github/workflows/release-please.yml` runs
[release-please](https://github.com/googleapis/release-please-action) on every push to `main`. It
keeps one pull request open, *chore(main): release X.Y.Z* on the branch
`release-please--branches--main--components--board-planner`, that bumps `package.json`,
`package-lock.json` and `.release-please-manifest.json` and prepends the new section to
`CHANGELOG.md`, all read from the conventional commits since the last release: `feat` is a minor
bump, `fix` a patch, `!` or `BREAKING CHANGE` a major; `ci`, `docs`, `test`, `build`, `chore` and
`refactor` bump nothing and stay out of the changelog. A merged pull request contributes its title
and each of its commits.

**Merging that pull request is the release.** The push it makes to `main` runs the workflow again,
which tags `vX.Y.Z` on the merge commit, creates the GitHub release with the changelog section as
its notes, and — in the same run — calls `release.yml` with that tag. It has to call it: a tag
created with `GITHUB_TOKEN` starts no workflow of its own. The called jobs check out the tag, not
`main`, so a commit landing in the meantime is not built into the release.

| Where it is set | What |
| --- | --- |
| `release-please-config.json` | `release-type: node`, tags without the package name (`v1.2.3`), and `bootstrap-sha` at `v1.0.1`'s commit |
| `.release-please-manifest.json` | The last released version. It started at `1.0.1`, so the first release PR holds only what came after `v1.0.1` |

The `release-please` job holds `contents`, `issues` and `pull-requests: write`; the job that calls
`release.yml` grants `contents: write` and `packages: write`, the ceiling for the called jobs, each of
which still narrows to its own permissions below. A called workflow's jobs cannot hold more than the
calling job grants.

**Two things GitHub does not do for this pull request:**

- **Create it, until it is allowed to.** *Settings → Actions → General → Workflow permissions →
  Allow GitHub Actions to create and approve pull requests* must be ticked, or the job fails with
  *GitHub Actions is not permitted to create or approve pull requests*.
- **Run CI on it.** A branch pushed with `GITHUB_TOKEN` triggers no workflow, so `ci.yml` never runs
  on the release branch. `main` has no branch protection and no ruleset, so nothing blocks the
  merge; the pull request only changes versions and the changelog, and CI runs on `main` after the
  merge because that push is yours. To see it green first, **Actions → CI → Run workflow** on the
  release branch.

  Making CI run on its own takes a token that is not `GITHUB_TOKEN`. The least privilege is a GitHub
  App installed on this repository alone with *Contents* and *Pull requests* read-and-write, its
  token minted per run by `actions/create-github-app-token` and passed as the action's `token`. That
  token's tag push then starts `release.yml` by itself, so the `release` job in
  `release-please.yml` has to go in the same change, or every release builds twice.

A tag pushed by hand still releases (below), but release-please does not know about it: bump
`.release-please-manifest.json` and `package.json` to that version in a commit, or the next release
PR proposes a version that already exists. To force a version, put `Release-As: 2.0.0` in a commit
body.

A called run that fails — say notarisation times out — is re-run from its Release Please run with
**Re-run failed jobs**. The tag and the release already exist, the build checks the tag out again,
and publish uploads over the assets. **Re-run all jobs** builds nothing: release-please finds the
release already made and reports `release_created=false`.

`fix`, `perf`, `revert` and `deps` commits bump the patch, `feat` the minor, and `!` or a
`BREAKING CHANGE` footer the major.

The action is pinned to the commit of its v5.0.0 release, because its outputs start the signing
build. Bump the SHA deliberately, from the action's release page.

## From CI — what the release runs

`.github/workflows/release.yml` runs on a pushed tag `vX.Y.Z` or when `release-please.yml` calls it
with one. A `resolve` job reads the tag — from the call's `tag` input, or the pushed ref — and every
other job takes the version from it, never from `github.ref`, which is `main` when called. Then three
jobs:

- **build** (`macos-latest`, `contents: read`, environment `release`). Installs the worker with
  `npm ci --ignore-scripts`, builds it, runs the Swift tests and packs the worker tarball, all
  before any secret touches the disk. Then it imports the Developer ID into a temporary keychain,
  runs `bundle.sh release` as a universal build (arm64 and x86_64), notarises with an App Store
  Connect API key (90-minute limit, submission id printed first), staples (three tries), and
  requires `spctl` to report `source=Notarized Developer ID`. The keychain and key files are
  deleted in an `always()` step. The assets go up as a workflow artifact kept for 3 days.
- **publish** (`ubuntu-latest`, `contents: write`, releases only). Downloads that artifact and
  attaches it to the release. A release from release-please exists already, with its changelog as
  the notes, and only gets the assets (replacing any from an earlier attempt); a tag pushed by hand
  has no release yet and gets one with generated notes.
- **image** (`ubuntu-latest`, `contents: read` + `packages: write`, releases only). Builds the
  repository's `Dockerfile` for `linux/amd64` and `linux/arm64` (QEMU + Buildx) and pushes
  `ghcr.io/rafalpodles/board-planner:X.Y.Z` — and `:latest` only when `vX.Y.Z` is the highest
  `vX.Y.Z` tag in the repository (`git tag --sort=-v:refname`, pre-release names ignored), so a
  backport such as `v1.1.1` pushed after `v1.2.0` does not take `latest` backwards — with the
  workflow's own `GITHUB_TOKEN`,
  labelled with the OCI `source`, `version` and `revision` so GHCR links the package to the
  repository. It needs no environment and no secret, and depends on neither job above: a failed
  notarisation does not hold the image back, nor the reverse. The image bakes in no address — every
  link the app builds comes from `PUBLIC_ORIGIN` at runtime. A mistaken high tag (say `v9.0.0`)
  keeps `latest` from moving until that tag is deleted.

| Asset | What it is |
| --- | --- |
| `board-planner-menubar-X.Y.Z.zip` | The app, worker inside, signed, notarised and stapled |
| `board-planner-worker-X.Y.Z.tar.gz` | The worker alone, for a machine run by hand: `worker/` with `dist/`, `package.json`, `launchd/`; runs with `node`, no install |
| `SHA256SUMS` | Checksums of both |

The app's `CFBundleShortVersionString` and the worker tarball's `package.json` both carry the tag's
version. The build number, `CFBundleVersion`, is `github.run_number` of whichever workflow started the
run — Release Please's or Release's — so it is not comparable between the two paths; the app reads
neither. The running worker still reports a hard-coded `1.0.0` to the server (BP-768).

By hand, bypassing the release PR:

```bash
git tag v1.0.1 && git push origin v1.0.1
```

**Actions → Release → Run workflow** is a dry run: the build job, attached to no release, and the
same image build for both architectures, pushed nowhere (`image-dry-run`, `contents: read` only).
The macOS artifact is still downloadable by anyone for 3 days, because the repository is public. Turn
*signed* off to exercise it before the secrets exist; that run uses no environment.

### The image's package is private until you say otherwise

GHCR creates a new package as **private**, whatever the repository's visibility, so after the first
tag push `docker pull` fails for everyone else until it is made public, once: **GitHub → your profile
→ Packages → `board-planner` → Package settings → Danger Zone → Change visibility → Public**
(<https://github.com/users/rafalpodles/packages/container/board-planner/settings>). Later
pushes keep that visibility. The same page, under *Manage Actions access*, should list this
repository with the *Write* role; a package first pushed by this workflow gets that on its own.

### The `release` environment

The secrets are **environment** secrets, not repository secrets: **Settings → Environments → New
environment → `release`**. Under *Deployment branches and tags* choose **Selected branches and
tags** and add the branch `main` and the tag pattern `v*`, so no other ref can reach the signing
certificate. Both are needed: a hand-pushed tag runs on `refs/tags/vX.Y.Z`, while a release from
release-please runs on the calling workflow's ref, `refs/heads/main`. A required reviewer is optional and makes every signed run wait for approval.

The build job stops before signing unless all six are set, and names each missing one:

| Secret | Holds |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | The *Developer ID Application* certificate and its private key, exported as `.p12`, base64 |
| `MACOS_CERTIFICATE_PASSWORD` | The password the `.p12` was exported with |
| `APPLE_TEAM_ID` | The team id (see below: the `OU`, not the id in a development certificate's name) |
| `ASC_KEY_ID` | App Store Connect API key id |
| `ASC_ISSUER_ID` | App Store Connect issuer id |
| `ASC_KEY_P8_BASE64` | The downloaded `AuthKey_<id>.p8`, base64 |

A notarisation that has no verdict within the limit fails the job with its submission id. Finish
it by hand with `xcrun notarytool wait <id>` and staple, or re-run the job.

## By hand

`bundle.sh` signs with the hardened runtime, notarises, staples and produces a zip — it just needs
an identity to sign with. `CP_VERSION`, `CP_BUILD_NUMBER`, `CP_ARCHS` and `CP_NOTARY_TIMEOUT` (default `90m`) are what CI sets; unset,
the build is `1.0.0`, build 1, for this Mac's architecture.

## The signing path is already proven with a real certificate

Dry-run with the existing `Apple Development` identity — not ad-hoc — so the only untested part is
substituting the Developer ID:

```
flags=0x10000(runtime)                     hardened runtime on, no longer adhoc
Authority=Apple Development: … → Apple Worldwide Developer Relations CA → Apple Root CA
TeamIdentifier=7RSD626AHC
```

`bundle.sh` then stopped by itself with "signed but NOT notarised", which is the branch that runs
when `CP_NOTARY_PROFILE` is unset.

## What is already true, measured rather than assumed

Both risks recorded on CP-239 were tested on the build machine with an **ad-hoc signature and the
hardened runtime turned on**, which is the same configuration a Developer ID build uses apart from
the identity:

- **The hardened runtime does not block spawning `node`.** It constrains what *this* process loads
  into itself — library validation, JIT, `DYLD_` variables — and a child process is a separate
  process with its own signature. `./bundle.sh release && .build/CPMenubar.app/Contents/MacOS/CPMenubar --preflight`
  from a stripped environment resolves every tool and reports them green. **No entitlement is
  needed for this**, which is why `Resources/CPMenubar.entitlements` is almost empty.
- **`SMAppService` works under the hardened runtime.** `--register-login-item` reports
  `Starts at login`, `--unregister-login-item` puts it back.

The app is **not sandboxed**, deliberately. A sandboxed build could not spawn an arbitrary `node`,
could not read the operator's checkout, and could not write `~/.boardplanner`.

## One-time, and only you can do these

1. **Take out the paid Apple Developer Program membership.** The machine already has an
   `Apple Development` certificate; that one comes with a free account and is for development only.
   It satisfies neither Gatekeeper on another Mac nor notarisation.

   **The team id is `7RSD626AHC`.** Not `7KJ3M7A835` — that number appears in the certificate's
   common name (`Apple Development: … (7KJ3M7A835)`) and is the *certificate* id, which is easy to
   copy by mistake. The team is the `OU` field, and `codesign -d --verbose=2` prints it as
   `TeamIdentifier`. Getting this wrong makes `notarytool store-credentials` fail in a way that
   looks like a bad password:

   ```bash
   codesign -d --verbose=2 <any signed .app> 2>&1 | grep TeamIdentifier
   ```
2. **Create a _Developer ID Application_ certificate** and install it. Check it landed:

   ```bash
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```

3. **Store notarisation credentials once**, using an app-specific password from appleid.apple.com:

   ```bash
   xcrun notarytool store-credentials "boardplanner" \
     --apple-id "you@example.com" --team-id "7RSD626AHC" --password "app-specific-password"
   ```

## Then

```bash
cd worker && npm ci && npm run build && cd ..          # the 200 KB the app carries
CP_SIGN_IDENTITY="Developer ID Application: … (7RSD626AHC)" \
CP_NOTARY_PROFILE="boardplanner" \
  menubar/bundle.sh release
```

That prints the path to `CPMenubar.zip` with the ticket stapled. `bundle.sh` runs
`spctl --assess --type execute` at the end, which is the decision another Mac will make on first
launch — read that line before sending the file anywhere.

`CP_NOTARY_KEY_PATH`, `CP_NOTARY_KEY_ID` and `CP_NOTARY_ISSUER` notarise with an API key instead
of a stored profile, which is what CI does. Without either it signs and stops, saying so. Without `CP_SIGN_IDENTITY` it is ad-hoc
and says that too — that build opens on the machine that made it and nowhere else.

## Sanity checks worth keeping

```bash
codesign -d --verbose=2 .build/CPMenubar.app 2>&1 | grep flags   # expect: runtime
codesign --verify --strict --deep .build/CPMenubar.app
xcrun stapler validate .build/CPMenubar.app
```

The real test is still a different Mac: copy the zip to one that has never seen the app, unzip, and
open it. Gatekeeper's answer there is the only one that counts.
