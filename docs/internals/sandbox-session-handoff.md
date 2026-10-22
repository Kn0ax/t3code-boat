# Sandbox session handoff

A project and its threads belong to one environment ([remote architecture](./remote.md)), so moving a
local thread into a cloud sandbox is a copy followed by a continuation, not a migration of live state.
[`@t3tools/sandbox-handoff`](../../packages/sandbox-handoff/src) holds the parts that touch git and
provider transcripts: a workspace snapshot, transcript location and path rewriting, and a script that
restores both inside the sandbox. The RPC that drives a move is not built yet.

## The snapshot never writes the user's repository

`snapshotWorkspace` captures tracked changes, deletions and untracked files that are not ignored, with
the staged state kept apart, as a single-ref git bundle. It must not change anything in `.git`, not
even an object's timestamp, and a test compares the directory before and after. See
[`snapshot.ts`](../../packages/sandbox-handoff/src/snapshot.ts) for how.

## Claude transcripts are keyed by the cwd's realpath

Claude files a session under a slug of its cwd's realpath (NFC-normalized on macOS). Names over 200
characters get a hash suffix that the Bun-built CLI computes differently from the Agent SDK, so a
target that would need one is refused rather than guessed. A symlinked target would file the transcript
under a slug the CLI never reads, so the import script refuses it. The slug rule is restated from the
SDK and must be rechecked when the SDK is upgraded.

## Native resume cannot use the continuation key

Native resume is trusted only within one continuation key, such as `codex:home:<home>`. A local key
never equals the sandbox's, so a move routed through the provider transition policy always becomes a
history handoff. Resuming natively needs a per-thread "transcript transferred to `<target key>`" fact,
recorded once the transcript is in the sandbox home. Changing either instance's key instead would
merge unrelated homes.

## Limits

- A snapshot does not carry ignored files, empty directories, in-progress merges or rebases, the stash,
  submodule contents or LFS objects.
- The whole bundle is held in memory on the server. boat's file API refuses any file over 5 MiB and
  its SDK has no signed URL for sandbox files, so the boat adapter moves a larger bundle as 4 MiB
  parts the sandbox splits or joins ([transfer.ts](../../packages/sandbox-boat/src/transfer.ts)).
  That costs a few extra calls per 4 MiB; a very large repository still wants a thin bundle or a
  sandbox-side fetch.
- Moving a Codex rollout by copying it is not verified against Codex's newer SQLite thread index.
