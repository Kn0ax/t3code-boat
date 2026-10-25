# Cloud sandboxes

A cloud sandbox is an environment created through boat. It runs the same `t3 serve` as any other
environment on port 3773. A sandbox added from the desktop app is reached through a loopback forward
in desktop main, the way an SSH environment is reached through a port forward. Like SSH, a sandbox
only changes how an environment comes to exist and how the client reaches it. See
[remote architecture](./remote.md). User setup is [Cloud sandboxes](../user/cloud-sandboxes.md).

There are three nouns, and they do not share a saved key:

- A desktop environment, created under Connections. The boat key lives in desktop secure storage.
- A sandbox job, started through the `sandbox_job_*` MCP tools. The boat key lives in the server secret store.
- A boat VM, started from a thread's Run on menu and reached over Tailscale. It uses the server's boat key.

## One contract

[`SandboxProviderShape`](../../packages/sandbox-core/src/SandboxProvider.ts) is the contract. The boat
adapter is [`@t3tools/sandbox-boat`](../../packages/sandbox-boat/src/factory.ts), built with `noEnv`
and the account's monitoring default. `SandboxProviderId` is the literal `"boat"`. The IPC contract restates that
literal so the renderer does not depend on sandbox-core, and
[`DesktopSandboxProviders.ts`](../../apps/desktop/src/sandbox/DesktopSandboxProviders.ts) fails to
compile if the two lists drift. Desktop main and the server both dynamic-import the boat package and
call `boatSandboxProvider`.

Sandboxes the user adds by hand are made by desktop main. The API key is write-only over IPC: the
renderer sees a key only while the user types it, and can never read a saved one back. The local
server is not involved in that create. The sandbox must exist before any server inside it can, and
the boat account belongs to the person at the desktop.

## Bootstrap traps

- **An exec that starts `t3 serve` and waits for it never returns.** That is why the contract has
  `startBackground` next to `exec`: `t3 serve` starts with the first, and readiness is checked with a
  separate `exec`. The SSH launch script cannot be reused as is.
- **The image may run as a non-root user**, so agent CLIs install under `$HOME/.local` instead of a
  system npm prefix.
- **A new preview route takes a few seconds to appear.** The probe retries for up to a minute before
  it gives up.
- **Create is idempotent per attempt.** A retried create with the same key adopts the sandbox the first
  attempt made instead of billing twice. The key includes whether `GH_TOKEN` was forwarded, so turning
  forwarding off before a retry always gets a fresh sandbox rather than one that still holds the token.
  A retry that finds its sandbox gone gets a replacement under a key naming the gone one.
- **A failed provision leaves the sandbox in place**, running and billed, and no environment row exists
  for it until the client has reached its server. The error tells the user to retry with the same
  settings, which adopts it, or to delete it in the provider's dashboard.

## Reaching the server

The renderer never connects to the provider's URL. Like an SSH environment, a sandbox route always
goes through desktop main, which opens a loopback forward per sandbox
([`sandboxForward.ts`](../../apps/desktop/src/sandbox/sandboxForward.ts)) that adds the provider's
headers to every request and WebSocket upgrade. A browser WebSocket carries no custom headers, so
the renderer cannot send them itself.

Because the forward's port changes when the app restarts, no bearer is kept: each connect asks the
desktop for a fresh forward and pairing token, since a saved address may belong to another process by
then. The first connect after an add or a start redeems the token that step already minted. The forward serves only `127.0.0.1` and `localhost` Host headers, so a page that rebinds
its name to loopback cannot read through it, and it only appends an origin-form request target to the
provider's origin, so no request (`//host/`, an absolute URL) carries the provider's headers elsewhere.

boat's public port URL is a bare origin. A dev server an agent binds to `0.0.0.0` on a published
port is reachable by anyone who learns that origin.

## Idle stop

boat's auto-stop is a deadline from the last start or `extendAutoStop`, not idle time. A sandbox
added under Connections can therefore stop under a running turn when its timer is short. boat VMs
(`apps/server/src/sandbox/BoatVmService.ts`) and sandbox jobs
(`apps/server/src/sandbox/SandboxJobService.ts`) avoid this while the server that holds the boat key
is up: maintenance calls `extendAutoStop` for a job that is not being stopped for idle, and the VM
keep-alive does the same while the VM looks busy. If that server goes away, the sandbox still stops
at the last deadline.

A connected client counts as busy, so the same pass also applies the VM lifecycle
(`apps/server/src/sandbox/BoatVmLifecycle.ts`) from the threads on the VM, and a VM it stops or
deletes gets no new deadline. Those threads live in the VM's own T3, which this server holds no
session for: the pass runs a script in the VM that issues a short-lived read token from the VM's
`t3` and asks its HTTP API over loopback, so no VM credential is stored here. The shell lists only
unarchived threads, so the server remembers the threads seen on each VM in
`boat-vm-threads.json` under its state directory.

Before the rules, the pass mirrors each changed VM thread into a local `import:boat-vm:…` thread
through `ThreadImportService.mirrorThread`, which writes only new or changed messages and items. The
state file keeps a version per mirrored thread, built from shell fields, so an unchanged thread is
never fetched; this mirror is also the final sync before a stop or delete. A failed sync blocks a
delete but not a stop, since a stopped VM keeps its disk. Subagent threads (a parent in their
lineage) are not mirrored: the copy resets lineage, so each would become a top-level thread here.
A running subagent still keeps its VM from stopping, since a delegated task can outlive its
parent's turn.

While the VM exists, its copies are followed: the lifecycle publishes their ids to
[`FollowedThreadCopies`](../../apps/server/src/orchestration-v2/FollowedThreadCopies.ts), and
`ThreadManagementService` rejects a `message.dispatch` to one before it commits. Without that, a send
from any client, an older one, or an agent would start a context-handoff run here and fork the
conversation away from the VM. The client turns the copy into a pointer instead (the copy's id
carries the sandbox and VM thread ids, `boatVmThreadCopyOrigin`). A copy with a run of its own that
did not fail is left alone and never deleted with its VM thread. A send that only failed, such as at
provider startup, does not make the copy the user's.

Once boat no longer lists the VM, its copies drop out of the set, but `ThreadManagementService`
still refuses a send to any `import:boat-vm:` thread without such a run: boat work never runs on
the manager. The copy continues on a new VM instead, through `boatVms.launch` with
`continueThreadId` (no new RPC) or `boat_vm_thread_continue`. The server reads the repository from
the copy's project (no remote means Scratch), launches as usual, and after the sync, before the
launch returns and any client reaches the VM:

- restores the old VM's branches from `refs/t3/boat/<old id>/` in the manager's checkout, as a
  bundle the VM fetches, and checks out the thread's branch. They are there because every
  lifecycle stop or delete of a running VM runs bring home first: a stopped VM is deleted after
  its grace period without being reached, so its last stop is the last chance. A branch that went
  its own way on the VM is left as it is, and a missing checkout here is a launch warning.
- puts the conversation into the VM's T3 through its existing `POST /api/orchestration/threads/import`
  over loopback, with a token and a pairing code the VM's `t3` mints, then sends the message with
  `t3_thread_send`. It runs after `t3 serve` starts because no released `t3` can append to a
  database offline, and a new subcommand would reach VMs only once a newer release is baked into
  the snapshots. The import endpoint shipped with the boat VM work, so a VM on a release without it
  fails the launch with that reason; a Scratch copy also needs a release that imports without a
  remote.

A failed hand-over discards the new VM like any failed launch and keeps the copy. On success the
copy is deleted: the VM's thread is imported under the copy's origin key, so it is named after the
copy (`import:boat-vm:<old id>:<thread>`), and its own copy here replaces the old one on the next
pass.

A copy deleted here is never brought back, and its VM thread counts as deleted once no run on it
is in flight. The first pass that sees the delete (the copy was still followed) deletes the VM
right away, skipping the stop and grace period, when every other thread is settled or archived and
nothing else is at work; otherwise it only marks the copy left alone, and the thread just stops
counting. The lifecycle's own `deleteCopy` cannot set this off: it only runs for a VM thread that
is already deleted, and drops that thread from the state file in the same step.

A VM whose threads are all settled is stopped, not deleted, and deleted only after
`BOAT_VM_SETTLED_DELETE_AFTER_MS` in that state (`settledSince` in the state file). A thread counts as
settled when the VM says so or its copy here was settled or archived after the thread's last
activity, so a client that cannot reach a stopped VM settles the copy instead. A stopped VM's
threads cannot change, so the stop settles every copy first and from then on the copies alone
decide: reopening one clears `settledSince`. Deleting a stopped VM never execs into it, since that
could start it, so its tailnet node is not logged out; an auth-key node is ephemeral and leaves on
its own.

boat VMs are reached over Tailscale rather than boat's public port URL, so they need no loopback
forward and every client on the tailnet can pair with them. A VM made from a named snapshot inherits
the snapshot source's Tailscale node key; the join script drops that state when the VM's id differs
from the one recorded on its disk, or two machines would fight over one node.

## Credentials inside the sandbox

- `GH_TOKEN` is forwarded only when the user opts in for that sandbox. It is in the environment of
  `t3 serve` and every agent, and a git credential helper that reads it lets git push to GitHub.
- boat sandboxes are created with `noEnv`, so account-level secrets stay out of the VM.
- Never copy a local Codex `auth.json` into a sandbox. Its refresh token rotates, so the first side to
  refresh signs the other out.
- Adapters map SDK errors to fixed failure labels and keep the raw error in `cause`, which is never
  serialized. Script output is classified into fixed phrases rather than quoted, because the sandbox
  environment holds tokens.

## Sandbox jobs

A sandbox job is a node an agent starts through the `sandbox_job_*` MCP tools: a sandbox that holds one
job and its disk until an agent or the user declares the job done. Runs end; the node does not. It
stops when idle and resumes on the next run.

- **The server owns these keys.** Agents call the server, possibly with no desktop attached (headless
  `t3 serve`, a remote client, a scheduled task), so provider and agent keys for jobs live in the
  server's secret store, separate from desktop main's.
- **The node is driven through its own `/mcp`.** The server signs in as an MCP OAuth client, spending
  the bootstrap's one-time pairing code as a full-access approval, and then calls the ordinary
  orchestrator tools. There is no server-to-server protocol to keep in step. A resumed node mints a
  fresh code, so every reconnect signs in again.
- **Work moves as git bundles.** The caller's checkout, with uncommitted work, goes in as a bundle on
  branch `t3/sandbox/<jobId>`. Completing the job commits in the node and brings back a bundle thin
  against the base, fetched to `refs/t3/sandbox/<jobId>`, so the local checkout is never touched.
- **Node threads run full-access.** The node is the isolation boundary and nobody watches its approval
  prompts, which is why starting, continuing, completing and discarding a job need a full-access caller.
- **Only bring-up failures destroy a node on their own.** A failed run or a failed collection keeps it,
  so no work is lost. A restart fails jobs caught mid-bring-up and destroys their node, but only once
  provisioning returned its ref. A create that fails after boat has assigned an id stores that id
  before the error is returned, so the failure path can destroy the node. A process that dies before
  that write commits can leave an untracked VM.

## Boat manager link

A server without a boat key can link to the one that has it (the manager) and forward
`boat_vm_list`, `boat_vm_thread_launch` and `boat_vm_save_snapshot` to the manager's `/mcp`
([BoatManagerLink](../../apps/server/src/sandbox/BoatManagerLink.ts)).

- **The pairing code is spent while saving settings.** `serverUpdateSettings` hands
  `sandboxJobs.boatManager.pairingCode` to `BoatManagerLink.prepareSettingsPatch`, which signs in
  and stores the session instead. There is no link RPC on purpose: one more method in the WebSocket
  RPC group crosses a TypeScript size limit and silently turns the server's RPC types into `any`.
  The code is never stored; the session token is a settings secret, so it lives in the secret store
  like the provider keys.
- **VMs link back with a narrow session.** On every launch or resume of a VM on the tailnet, the
  manager mints a one-time code holding only `boat-vms:operate`, labelled with the VM's sandbox id
  ([BoatVmManagerAccess](../../apps/server/src/sandbox/BoatVmManagerAccess.ts)), and the VM saves
  it through its own `serverUpdateSettings` over loopback, as a user would. Whatever access the VM
  asks for, that code approves only the `boat-vms` access level: a 24-hour `mcp-client` session with
  no orchestration scopes and no MCP capabilities. McpHttpServer refuses such a client every tool but
  those three before any handler runs, and the three handlers take it without a caller, so it cannot
  name a project here. A new code first revokes the VM's earlier codes and sessions; deleting the VM
  revokes them too.
- **Relay-only VMs do not link.** The VM reaches the manager at the manager's tailnet origin
  (Tailscale Serve, else a tailnet address, from DirectEndpoints). A VM reached only over the boat
  relay has no route to it, and a manager with no tailnet origin links nothing.
- **The VM must run a release that has the link.** VMs install the host's published version, or the
  pinned nightly when the host's version was never published. A release without the link drops the
  unknown setting; the VM step reports that and the launch carries on without the link. A fork's
  version names an upstream release with different code, so a fork host sets
  `T3CODE_RELEASE_BASE_URL` to its own release downloads and `T3CODE_SANDBOX_T3_VERSION` to the
  release its VMs and job nodes install (`sandboxT3Release` in
  [SandboxJobService.ts](../../apps/server/src/sandbox/SandboxJobService.ts)).
