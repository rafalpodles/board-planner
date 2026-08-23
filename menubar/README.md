# CPMenubar

The operator's cockpit for the Board Planner execution worker: a menu bar app that shows whether a
run is stuck or working, raises a notification when one ends, and manages the repository allowlist.

## What it talks to, and what it does not

Its only I/O is the worker's unix socket at `${CP_STATE_DIR}/worker.sock` (default
`~/.boardplanner/worker.sock`) and the allowlist at `${CP_STATE_DIR}/repos.json`.

**It holds no Board Planner credential and never opens a network connection.** Registration and
policy live on the worker and in the web console; the Connection and Policy tabs are read-only
views of what the worker reports over `GET /config`. This follows from what registration is —
a credential minted for this machine acts with its owner's reach, and there is no reason for a
second process to hold a copy.

## What the server sends, and where each value lands

The app opens no network connection, but the worker's socket relays values that originated on the
board, and two of them used to decide what ran and where. This is the menubar half of the sweep in
[`worker/README.md`](../worker/README.md) (BP-327, BP-399); the worker half covers everything that
arrives over HTTP.

| Value | Comes from | Ends up as | What holds it |
| --- | --- | --- | --- |
| `repositoryUrl` | the catalogue and offers, over `/config` | `git clone`'s source | `CloneInputs.isRemote` — https, http and ssh only, no whitespace, no leading dash — and `--` after the subcommand |
| project `key` | the same | `<parent>/<key>`, and then a line in `repos.json` | `CloneInputs.isProjectKey` — one directory name, the same shape the worker demands of a task key — plus `isContained`, because `appendingPathComponent` does not normalise `..` |
| checkout paths | `repos.json`, written by the step above | `git -C <path> …` | option values, never positionals; contained once the key above is |
| `apiURL`, `workerName`, `toolPath` | the operator, through onboarding | the worker's environment | not the server's to set |
| status, config, telemetry | the worker's socket | rendered | display only |

**Two transports run a program, and neither is refused by looking at the URL.** `ext::` hands the
URL to one, and `git://` reaches `core.gitProxy`. A shape check does not see them arriving, because
`url.<base>.insteadOf` in the operator's own `~/.gitconfig` rewrites a well-formed `https://` remote
into either — measured on git 2.50.1 through the app's own spawn path, and it ran the program. So
the transports are closed twice: `protocol.ext.allow=never` and `protocol.file.allow=never` on the
command line, where `-c` outranks a global setting, and `GIT_PROXY_COMMAND=""` in the environment,
where it does not.

**What this costs.** Cloning from a local path or a `file://` URL is refused, both by the URL shape
and by `protocol.file.allow`. That was a development case — a local bare repository — and it is the
same case the push probe already said it could not really check.

**What it does not claim.** `~/.gitconfig` is still read, unlike the worker's delivery path. This
runs during onboarding, and dropping it would take the operator's credential helper and any
`core.sshCommand` deploy key with it, at the moment a failure is hardest to tell from a typo.

## Build

```
make test      # swift test
make app       # test, build the worker, assemble the app through bundle.sh, ad-hoc sign
make clean
```

`make app` produces `.build/CPMenubar.app`. `LSUIElement` keeps it out of the Dock and ⌘-Tab, so
the menu bar icon and ⌘, from the panel are the only ways in.

**The worker ships inside the app**, at `Contents/Resources/worker` — about 200 KB of JavaScript
with no runtime dependencies. `bundle.sh` is what puts it there, so an app assembled any other way
launches and onboards and then has nothing to run. That is why `make app` delegates to it rather
than assembling the bundle itself, and why it builds `worker/` first.

The app falls back to `<the folder chosen at onboarding>/worker/dist/main.js` when its own bundle
carries none. That is for running from a Board Planner clone during development — an operator's
folder holds *their* project, which has no `worker/` in it.

## Run

```
open .build/CPMenubar.app
```

Against a rig whose state directory is not the default, pass it through — the app reads the same
variable the worker does:

```
CP_STATE_DIR=$HOME/cp-rig/state .build/CPMenubar.app/Contents/MacOS/CPMenubar
```

## Layout

`CPMenubarCore` is the logic and holds no SwiftUI import, which is what makes it testable:

| File | Responsibility |
|---|---|
| `UnixHTTP.swift` | `Transport` protocol and its `NWConnection` implementation, plus response-head parsing |
| `TelemetryEvent.swift` | The untagged wire union — progress, quota, outcome — and its decoding |
| `SocketClient.swift` | `/status`, `/config`, `/stream` framing, and the three commands |
| `WorkerState.swift` | Reduces events into health, icon, title and stepper rows |
| `ReposFile.swift` | Reads and writes `repos.json` at 0600 |
| `Notifier.swift` | Decides which events deserve a notification, and delivers them |

`CPMenubar` is the SwiftUI shell — `MenuBarExtra`, the panel and the preferences window. It has no
unit tests; it is verified by running it.

## Notifications

Four, and only four: merged, gate rejected, needs a human, usage limit. Anything more and the
operator turns them off.
