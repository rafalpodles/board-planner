# Releasing the menubar app

Everything below the "one-time" section is already wired up. `bundle.sh` signs with the hardened
runtime, notarises, staples and produces a zip — it just needs an identity to sign with.

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
   `Apple Development` certificate on team `7KJ3M7A835`; that one comes with a free account and is
   for development only. It satisfies neither Gatekeeper on another Mac nor notarisation.
2. **Create a _Developer ID Application_ certificate** and install it. Check it landed:

   ```bash
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```

3. **Store notarisation credentials once**, using an app-specific password from appleid.apple.com:

   ```bash
   xcrun notarytool store-credentials "claudeplanner" \
     --apple-id "you@example.com" --team-id "7KJ3M7A835" --password "app-specific-password"
   ```

## Then

```bash
cd worker && npm ci && npm run build && cd ..          # the 200 KB the app carries
CP_SIGN_IDENTITY="Developer ID Application: … (7KJ3M7A835)" \
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
