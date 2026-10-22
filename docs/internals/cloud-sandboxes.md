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
and monitoring off. `SandboxProviderId` is the literal `"boat"`. The IPC contract restates that
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
