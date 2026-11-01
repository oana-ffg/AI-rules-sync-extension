# Extension-host runtime waste audit

The audit uses the actual compiled extension and its real filesystem code. Only
VS Code's panel, settings, commands, and notifications are stubbed. All fixtures
live in temporary directories and are removed after each test. Counts exclude
fixture setup and verification reads.

Measured with Node.js v24.22.1, comparing main at `d56bfd6` with this change.
Counts below are public Node filesystem API invocations, not kernel syscalls,
physical disk traffic, or measurements from a running VS Code process. HTTP(S)
request/get and fetch calls are intercepted and counted; no network request is
allowed by the harness. No timing or battery improvement is claimed.

## Findings and changes

### Saving byte-identical files rewrote every target

Each manual Save previously called mkdir and writeFile for every configured rule
file, even if its complete bytes already matched. This needlessly updated mtimes
and could wake other tools' watchers. The extension itself has no watcher.

Save now compares the complete existing text with the proposed per-file text,
including BOM, frontmatter, and line endings. Identical files still report success
but are not written. Existing files do not need a mkdir call; missing files still
get their parent directories created. Fresh reads, overwrite confirmation, and
post-save status reads are retained.

Both workspace sizes below contain 4,096 unrelated files. Each rule body is
26,624 bytes (`'shared rules\n'.repeat(2048)`). The changed-save case adds five
bytes per rule file. Each cell is **before → after**.

| Operation | Rule files | Reads | stat | lstat | realpath | mkdir | Writes | Bytes written | Synchronous calls |
| --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- |
| Load | 6 | 6 → 6 | 6 → 6 | 6 → 6 | 12 → 12 | 0 → 0 | 0 → 0 | 0 → 0 | 30 → 0 |
| Unchanged Save | 6 | 12 → 12 | 12 → 12 | 12 → 12 | 24 → 24 | 6 → 0 | 6 → 0 | 159,744 → 0 | 72 → 0 |
| Load | 256 | 256 → 256 | 256 → 256 | 256 → 256 | 512 → 512 | 0 → 0 | 0 → 0 | 0 → 0 | 1,280 → 0 |
| Unchanged Save | 256 | 512 → 512 | 512 → 512 | 512 → 512 | 1,024 → 1,024 | 256 → 0 | 256 → 0 | 6,815,744 → 0 | 3,072 → 0 |
| Changed Save | 256 | 512 → 512 | 512 → 512 | 512 → 512 | 1,024 → 1,024 | 256 → 0 | 256 → 256 | 6,817,024 → 6,817,024 | 3,072 → 0 |
| Repeat Save | 256 | 512 → 512 | 512 → 512 | 512 → 512 | 1,024 → 1,024 | 256 → 0 | 256 → 0 | 6,817,024 → 0 | 3,072 → 0 |

Unchanged Save reads 13,631,488 bytes at 256 files in both revisions. This is
intentional: the first pass checks disk changes and preserves each frontmatter;
the second reports fresh file statuses. Neither revision scans unrelated files.
All measured operations perform zero explicit fsyncs and zero network requests.

### File operations blocked the shared extension-host thread

Load, Save, status refresh on panel visibility/configuration changes, and path
validation used synchronous filesystem APIs. At 256 configured rule files, a
Load made 1,280 synchronous calls and a Save made 3,072. Slow disks make these
calls stall other extensions too; stall duration was not measured.

All filesystem operations now use fs.promises. Reads run in batches of at most
eight files; writes remain sequential, so a large configuration cannot flood the
filesystem queue. The tests observed at most eight pending filesystem operations
and zero synchronous filesystem calls. The six-file case observed at most six.

The host now permits one panel operation at a time and coalesces refresh requests
into one pending refresh. Load and Save buttons are disabled together until the
operation's result/status refresh arrives. Unexpected simultaneous Load/Save
requests receive a visible busy warning rather than starting another operation.
Failures release the operation lock and display an error.

A stress harness directly delivers two Save messages while an overwrite
confirmation is held open. Before: two confirmations, 1,536 reads, 1,536 stat,
1,536 lstat, 3,072 realpath, 512 mkdir, and 512 writes. After: one confirmation,
768 reads, 768 stat, 768 lstat, 1,536 realpath, zero mkdir, and 256 writes.
Synchronous calls drop from 8,704 to zero. This tests the host guard; the original
webview already disabled its Save button during a Save, so these duplicate
messages are not claimed to represent a normal double-click.

## Regression coverage

- Six and 256 rule files beside 4,096 unrelated files: zero unchanged/repeated
  writes, exact changed-file write count, exact read counts, no scans, no explicit
  fsyncs, no network requests, zero synchronous I/O, and bounded pending I/O.
- Mixed unchanged/changed/missing files: exactly two writes and one mkdir, with
  byte-identical BOM/CRLF frontmatter and mtime preserved on the unchanged file.
- Two overlapping Save messages: one sync and one overwrite confirmation.
- A blocked load of 128 files plus 200 visibility/configuration refresh events:
  exactly 256 reads (one load and one following refresh), at most eight pending
  filesystem calls, and one status notification.
- Write-error reporting and subsequent save recovery; webview button states and
  load-error recovery.
- Existing tests retain overwrite cancellation, changed files during confirmation,
  symlink containment and revalidation, frontmatter separators, and path errors.

## Checked and rejected

- `onStartupFinished` activates in every window, but activation registers three
  commands and the documented status-bar shortcut. It performs zero measured
  filesystem/network operations and registers no poller or file watcher. Removing
  startup activation would remove the status-bar shortcut until a command ran.
- No save/change watchers, broad globs, workspace scans, subprocesses, network
  calls, or work per textarea keystroke exist in the runtime source.
- No recurring extension-host timers exist. The webview's one five-second status
  timeout replaces its predecessor. Eight hours of idle usage was not observed.
- Reading every configured file on Load is needed for per-file status; returning
  only the first file would lose divergence/error information. Fresh reads on Save
  protect external changes and per-file frontmatter. No persistent content cache
  was introduced; there is no watcher to invalidate one safely.
- Keeping a hidden panel's context preserves unsaved edits. There is only one
  panel, so this is bounded and intentional.

## Reproduce

Install the locked dependencies, then run all regression tests:

```sh
npm ci --cache .audit-npm-cache --fetch-retries=0
npm test
npm run compile
```

For the before counts, compile the original source into the ignored build output
and run only the measurement scenarios. The same test code and fixtures run on
both revisions. `AUDIT_MEASURE=1` prints counts instead of asserting the fixed
version's expectations. Regular `npm test` always applies those assertions.

```sh
mkdir -p .audit-baseline
git show d56bfd6:src/extension.ts > .audit-baseline/extension.ts
./node_modules/.bin/tsc --strict --target ES2020 --module commonjs --rootDir .audit-baseline --outDir out .audit-baseline/extension.ts
AUDIT_MEASURE=1 node --test --test-name-pattern='runtime waste audit' test/extension.test.cjs
npm run compile
AUDIT_MEASURE=1 node --test --test-name-pattern='runtime waste audit' test/extension.test.cjs
```

The second compile restores the fixed build output. No installed application or
real VS Code configuration is touched. No GUI or Extension Development Host test
was run. There is no CI workflow in this repository; adding a small npm ci/npm
test workflow would help keep the count regressions enforced. No workflow,
release, version bump, package upload, or VSIX is part of this change.

## Remaining notes

No additional confirmed runtime-waste finding was left unfixed and no dead code
was found. Saves remain non-atomic across files, and disk edits by other programs
can race filesystem reads/writes; the existing containment checks and reads after
overwrite confirmations remain. The stubbed harness does not measure VS Code's
own watcher behavior, network filesystem latency, or eight-hour idle usage.

Dependency installation reported two moderate vulnerabilities in the development
dependency tree. Dependency remediation is outside this runtime-waste change.
