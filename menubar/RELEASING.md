# Releasing the menubar app

Everything below the "one-time" section is already wired up. `bundle.sh` signs with the hardened
runtime, notarises, staples and produces a zip — it just needs an identity to sign with.

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
could not read the operator's checkout, and could not write `~/.claudeplanner`.

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
   xcrun notarytool store-credentials "claudeplanner" \
     --apple-id "you@example.com" --team-id "7RSD626AHC" --password "app-specific-password"
   ```

## Then

```bash
cd worker && npm ci && npm run build && cd ..          # the 200 KB the app carries
CP_SIGN_IDENTITY="Developer ID Application: … (7RSD626AHC)" \
CP_NOTARY_PROFILE="claudeplanner" \
  menubar/bundle.sh release
```

That prints the path to `CPMenubar.zip` with the ticket stapled. `bundle.sh` runs
`spctl --assess --type execute` at the end, which is the decision another Mac will make on first
launch — read that line before sending the file anywhere.

Without `CP_NOTARY_PROFILE` it signs and stops, saying so. Without `CP_SIGN_IDENTITY` it is ad-hoc
and says that too — that build opens on the machine that made it and nowhere else.

## Sanity checks worth keeping

```bash
codesign -d --verbose=2 .build/CPMenubar.app 2>&1 | grep flags   # expect: runtime
codesign --verify --strict --deep .build/CPMenubar.app
xcrun stapler validate .build/CPMenubar.app
```

The real test is still a different Mac: copy the zip to one that has never seen the app, unzip, and
open it. Gatekeeper's answer there is the only one that counts.
