# macOS terminal permissions across updates

Investigation for [#13921](https://github.com/stablyai/orca/issues/13921). Read this before
changing the macOS terminal daemon launcher or treating a missing executable as a permission denial.

## Reproduced on October 6, 2026

The windowless experiment in `tests/tools/macos-tcc-update/` uses private copies of the installed
Orca bundle, its Developer ID signing identity, and the existing Orca Full Disk Access grant.
It changes no permissions and never replaces the installed app. The parent is launched through
launchd, forks a detached Orca Helper, and exits. This prevents the test runner's own grant from
covering the test descendants.

The experiment reads one byte from the user's TCC database, discards that byte, and reports only
the outcome. This is a Full Disk Access probe; it does not inspect database contents or open
Files and Folders permission prompts.

On macOS 26.3.1, with matching designated requirements before and after signing the test build:

| Observation | Full Disk Access probe |
| --- | --- |
| Helper descendants before an update | Allowed |
| A warmed Helper after its old executable is deleted | Allowed |
| A cold Helper's first read while the original app path is absent | EPERM |
| The same Helper after restoring the signed bundle to that path | EPERM |
| A fresh Helper launched from the restored bundle | Allowed |
| A launchd daemon using an independent signed bundle copy, during the gap | Allowed |
| That independent daemon after restoring the source bundle | Allowed |

The original app's system TCC row remained enabled. Its designated requirement and the test
build's requirement were identical; SHA-256 of the displayed requirement was
`7cb0ecb28676c0662cd8b5e5ecf4897cdab7343357e25b115b7cad9cf5aa3b6d`.

This establishes an update-path gap as one reproducible cause of persistent denial. It also
establishes that an unresolvable running executable is not sufficient evidence of denial.
The signed launchd approach was also described in [#20452](https://github.com/stablyai/orca/pull/20452);
this branch independently repeats the native experiment and exercises the current production launcher.

It does not establish where macOS caches that denial, or that every reported Desktop/Documents/
Downloads or Local Network failure has the same cause. Those claims require additional evidence.

## Repeat the experiment

Use a Mac where Orca already has Full Disk Access and a signing identity matching that installed
app. The signing identity is an argument because contributor certificates and release teams vary.

```sh
ORCA_BACKGROUND_LAUNCH=1 python3 tests/tools/macos-tcc-update/run.py \
  --app /Applications/Orca.app \
  --identity 'Developer ID Application: <your identity>' \
  --output notes/tcc-update-results.json
```

The script checks that signing the private test build did not change its designated requirement.
It exits unsuccessfully if the baseline cannot read the FDA probe, if the lasting denial was not
reproduced, or if the independent launch lost access. Cleanup addresses only its own unique jobs
and daemon sockets. If an owned process cannot be confirmed exited, its runtime is preserved.

## Structural correction

A terminal daemon that must survive an update should have both:

- A complete signed app bundle whose path the updater never replaces or removes.
- Its own Orca responsible identity, independent of the UI process's replaceable app path.

Copying only the executable is insufficient: the signed bundle layout, resources, frameworks,
and native dependencies must remain available. Forking from the UI into a copied Helper also
leaves responsibility attached to the UI's original path. The experiment's successful branch
instead starts the copied main Orca executable through launchd in Node mode. It has Orca's
existing app identifier and signing requirement, so it needs no separate Helper grant.

`macos-daemon-bundle.ts` resolves the running main process's executable through `codesign`, copies
its bundle to a private runtime directory, and verifies both the copy's signature and the
unchanged designated requirement before any launch. This also avoids copying a newer build that
an updater may already have placed at `process.execPath`. APFS clones avoid duplicating unchanged
file blocks; other filesystems use a regular copy after removing any incomplete clone.

`macos-daemon-launchd.ts` starts that runtime as a unique, nonpersistent launchd job. Readiness is
the existing authenticated daemon handshake, fenced by the launch nonce. The temporary job file
has mode 0600 and is removed after bootstrap because inherited environment variables may contain
credentials. A connection failure retries observation of that same job; it never starts another
daemon just because observation timed out.

This path applies only to packaged macOS GUI applications. Node servers, SSH execution hosts,
unpackaged development builds, Linux, and Windows retain their existing launch mechanisms.
All workspace types use the same local daemon; the mechanism does not require a git worktree.

## Runtime retirement

Each private runtime records only its unique launchd label, producer PID, submission state and
bundle basename in a mode-0600 job record. Cleanup never reads or modifies terminal sockets,
authentication tokens or another daemon's PID record.

Explicit shutdown unregisters the owned job and then checks every open executable, library and
file under its copied bundle with `lsof`. Only a complete, successful absence observation permits
removal. A surviving child retains the copy even after its daemon exits. Unavailable inspection,
permission errors, warnings, truncated output and deadlines all retain code.

New daemon launches also start a background collection, coalesced per runtime root. Each pass
examines at most 20 runtime records and rotates past retained copies; directory iteration can
visit all names but only those 20 can trigger native job/file inspection. An unsubmitted record requires the producer to be
confirmed exited before inspection, preventing collection during bootstrap. A successful submission
can be collected while the UI is still running only after the job is stopped/unregistered and
no bundle files are open; repeated manual restarts do not retain every prior copy until UI exit. A stopped launchd job is unregistered before removal. An absent job with an uncertain
submission record is retained because a timed-out bootstrap might still complete. This can
retain an orphan after an uncertain failure; it is safer than deleting potentially live code.

The foreground launch has one 55-second deadline, leaving five seconds of the existing 60-second
PTY startup cap for provider installation. Copies and signature checks share that deadline, and
bootstrap is forbidden after it expires. There is no terminal-spawn copy, periodic collector,
or per-keystroke/process-list scan. Existing authenticated daemon adoption bypasses copying.

## Permission status and existing sessions

The Full Disk Access row reports the app and terminal hosts separately. The existing read probe
also runs inside each connected daemon generation. A denied generation wins; granted requires
every generation to report granted. Degraded mode also probes its in-process fallback host. An older daemon that lacks the new read-only request, a
malformed response, a timeout or lost contact remains unknown. The request adds no stream opcode
or protocol bump, and settings reads neither launch nor replace a daemon.

Already running old daemons keep their live terminals. Existing version/path replacement policy
upgrades idle daemons only after confirming zero live sessions. For an already denied terminal,
save its work and close it through Manage Sessions, then open a new terminal on the current host.
If fresh terminals also fail, the existing confirmed Restart action replaces the current daemon;
legacy sessions are preserved. The UI explains that restart closes the current host's terminals.
No permission check or automatic update kills live work.

The packaging hook now gives Desktop, Documents and Downloads descriptions to the main bundle
and all four Electron Helpers before signing. Bundle identifiers and signing requirements are
unchanged; the daemon uses the main Orca identity and needs no separate Helper FDA grant.

## Production verification

After rebuilding, run the signed production integration harness:

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm run build:electron-vite
ORCA_BACKGROUND_LAUNCH=1 python3 tests/tools/macos-tcc-update/product.py \
  --app /Applications/Orca.app \
  --identity 'Developer ID Application: <your identity>' \
  --output notes/tcc-product-results.json
```

It applies the actual Helper packaging hook, preserves each Helper's designated requirement,
embeds the rebuilt daemon, and signs three different private bundle versions. The actual
production launcher starts an authenticated protocol-41 daemon. Temporary owned witnesses under
Desktop, Documents and Downloads test real PTY startup cwd, `/bin/pwd`, file content reads,
Apple Git and one discarded FDA byte through both replacement gaps and old-bundle deletion.
Persistent terminals, six fresh terminals and a reconnect all retain the same daemon identity.
Only owned test folders, profiles, jobs and app copies are touched; no privacy grant is changed.

October 6 local evidence on macOS 26.3.1 arm64:

- The initial production integration passed all seven FDA reads through two updates.
- The expanded integration passed 22 cwd/file/Git/FDA checks across all three protected folders,
  two different signed versions and reconnect. A cold launch took 25.9 seconds during concurrent
  test work; the final packaging-hook run took 6.8 seconds. These are observations, not latency guarantees.
- The final daemon suite passed 2,401 tests across 212 files, with 15 tests and three files skipped.
- After the final run, a retained, stopped runtime was removed by the production collector in
  474 ms after verifying the producer exit, absent job and no open bundle files.
- Full type checking, the changed-code quality gate and Electron/Vite build passed.
- The production permissions component rendered denied, unknown and granted host states through
  Playwright CDP in a hidden Electron window; denied was inspected in both light and dark themes.
  This uses injected status replies to verify presentation; the signed PTY test proves actual
  execution-host access separately.

A first integration attempt exposed Electron's asar filesystem shim during bundle removal.
Runtime cleanup reuses `asar-transparent-fs.ts` so app.asar is removed as a file. The repeatable
harness also normalizes macOS `/tmp` and `/private/tmp` before checking its owned-copy boundary.

## Reliability scope and remaining gaps

Gate: `terminal.macos-tcc-update-identity` in `config/reliability-gates.jsonc`, experimental.
The signed harness supplies red/green evidence for the actual update-gap denial and stable
launch, while deterministic tests cover ownership, unknown verdicts, deadlines, cleanup and
live-session preservation. No cross-platform soak or claim that all macOS privacy services have
one failure mechanism is made.

| Surface | Evidence / scope |
| --- | --- |
| Packaged macOS daemon PTYs | Signed native update-gap reproduction and 22 production PTY checks |
| Folder workspaces / git worktrees | Launcher is workspace independent; protected ordinary folders and Git repositories tested |
| Existing current / legacy sessions | Full daemon preservation/restart suite; older permission methods degrade to unknown |
| Linux / Windows / WSL | New launch path is bypassed in runtime-guard tests; existing provider paths unchanged |
| SSH / Node remote hosts | macOS GUI-watch + packaged-app guard bypasses stable copying; no remote filesystem or liveness inference |
| Mobile / relay | No runtime RPC, stream or renderer terminal changes; daemon method is additive and local-settings only |

Physical macOS x64, older supported macOS releases, actual GUI quit/relaunch during ShipIt,
logout/login, notarization/Gatekeeper after a real release and individual folder grants without
FDA still need release-lane coverage. FDA-protected Desktop/Documents/Downloads and Apple Git
are covered; Local Network, Accessibility and Automation were not claimed or exercised. A
crash before job metadata publication, an uncertain bootstrap or an uninspectable process may
retain a private copy. Regular copies on non-APFS volumes can consume a full bundle and can hit
the shared startup deadline; native non-APFS performance is unmeasured.
