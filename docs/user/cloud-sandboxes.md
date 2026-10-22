# Cloud sandboxes

T3 Code can run work on [boat](https://boat.dev). You need a boat API key. boat
runs every sandbox in the EU, and a running sandbox bills that account until
you stop or delete it.

The key must allow creating, resuming, and deleting sandboxes as well as running commands,
reading and writing files, hosting ports, and reading and saving snapshots. Boat's `full-sandbox` preset does
not include create or delete. With the Boat CLI, create a key with:

```sh
boat api-key create t3code --actions sandbox.create,sandbox.read,sandbox.update,sandbox.stop,sandbox.resume,sandbox.delete,exec,file.read,file.write,host,snapshot.read,snapshot.write,account.read
```

boat's stop timer is a deadline from the last start, not a measure of idle
time. T3 Code keeps a sandbox job or a boat VM alive while this server is up
and the sandbox still has work. A desktop sandbox stops the number of minutes
you set after it starts, even mid-task. Use 0 to leave auto-stop off.

## Add a boat environment

This path exists in the desktop app.

1. Open **Settings → Connections → Add environment**.
2. Choose **Cloud sandbox**.
3. Paste a boat API key. It is saved in this computer's secure storage, and the
   form never reads it back. **Save the key without creating a sandbox** stores
   it for the next add. **Forget it** removes it.
4. Leave the size on Small, or pick Medium or Large. Leave **Auto-stop after**
   at 30, or set a whole number of minutes from 0 to 10080.
5. Leave **Install coding agents** on unless the image already has Claude Code
   and Codex. Sign in on the sandbox later. Do not copy a local Codex login
   into it. Its refresh token rotates, so one copy signs the other out.
6. Leave **Forward my GitHub token** off unless this computer's `gh` login
   should be injected as `GH_TOKEN`. Anything in the sandbox, and boat, can
   use that token.
7. Choose **Create sandbox**. The first create can take a minute.

The new row is labeled **boat sandbox**. **Start sandbox** resumes a stopped
VM. **Stop sandbox** stops it and keeps the disk. **Delete sandbox…** deletes
it. **Remove from this device…** forgets the row and leaves the VM running.

A stopped sandbox stays stopped until you start it. If create fails after boat
has already made the VM, it keeps running and billing. Create it again with the
same size, stop timer, and GitHub-token choice to retry that VM, or delete it
in the boat dashboard. Quitting the app forgets that retry.

A browser tab of the web app, and a desktop build without these controls, has
no **Cloud sandbox** card. A saved sandbox row on those clients says cloud
sandboxes are only available in the desktop app.

## Sandbox jobs

Turn on **Settings → Integrations → Sandbox jobs** and save a boat API key
there, plus an agent key: an Anthropic key for Claude, or an OpenAI key for
Codex. These keys are stored on the T3 Code
server, separate from a key saved in the desktop app, so jobs work from any
client.

One environment holds these keys and starts boat VMs and sandbox jobs for this
device: your primary connection, unless you pick another under **Boat VMs →
Managed by**. The choice is saved on this device. Settings for any other
environment link to the one that manages them.

Ask an agent to run something in a sandbox job. The job gets a copy of the
workspace, including uncommitted changes, and keeps that disk between
messages. When it has been idle for the time you set, the sandbox stops and
starts again on the next message. A job ends only when it is completed, which
brings the work back into the repository without touching the checkout, or
when it is discarded. Each job bills the boat account until then.

If the boat key is missing, the error names **Settings → Integrations →
Sandbox jobs**.

## boat VMs

Save the same server boat key under **Settings → Integrations → Sandbox jobs**.
The VM options are in the **Boat VMs** section below it. Once the key is saved,
**Base snapshot** and **Boat environment** list your boat account's snapshots
and environments. If boat cannot be reached, type the names instead. With the default **VM
connection**, **Protected Boat URL**, T3 connects to the
VM through the environment that holds the key, so no Tailscale is needed.

**Tailscale** decides whether a VM joins your tailnet:

- **Off**: it does not. Its ports cannot be previewed directly.
- **Auth key**: T3 joins it with a reusable, ephemeral Tailscale auth key you
  save below the picker.
- **Snapshot joins itself**: the snapshot logs in on its own. T3 waits for its
  connection and preserves its Tailscale hostname and login. A saved auth key
  is used only when the snapshot cannot log a VM in. A plain VM cannot join
  this way.

With a Protected Boat URL, joining the tailnet gives the VM's ports and
webhooks a direct address. Choose **VM connection → Tailscale** to connect to
the VM directly within your tailnet instead, which needs Tailscale set to
**Auth key** or **Snapshot joins itself**. Desktop and locally hosted HTTP clients connect over
tailnet HTTP without waiting for a certificate. Web clients opened over HTTPS
also require HTTPS certificates enabled for the tailnet.

In a new thread whose project has a Git remote, open **Run on** and choose
**New boat VM**, or an earlier VM. A new VM starts from a boat snapshot named
`t3-<owner>-<repo>` (lowercase), else the **Base snapshot** (`t3-base` by
default), else a plain VM. It checks the repository out at `~/work/<repo>` and
joins the tailnet when Tailscale is set up. Cancelling a start deletes a new
VM, as a failed start does; an earlier VM is kept.

To make a snapshot, set a VM up, then choose **Save boat VM as snapshot** in
the command palette and pick the VM. The name defaults to `t3-<owner>-<repo>`,
so new VMs for that repository start from it. Saving under an existing name
replaces that snapshot once the new one is ready. A notification follows the
save, which can take several minutes.

A new VM gets no secrets from your boat account. To give it the agent logins
and secrets of a boat environment, choose that environment under **Boat
environment**. Only VMs you start from **Run on** attach it; agents' sandbox
jobs never do.

Save a GitHub token in the same settings for private repositories. The keys
are written when the VM starts and deleted from its disk, so a snapshot does
not carry them. Make sure the snapshot's Tailscale setup gives each new VM
its own machine identity.

A VM archives once nothing has happened on it for the minutes you set, 30 by
default, and keeps its disk. Picking it again resumes it. Only the server that
holds the boat key keeps VMs up, so run that server on a machine that stays
on. A VM started from a desktop app archives when that computer sleeps or the
app quits.

**Bring boat VM work home** in the command palette fetches the VM's branches
into the local checkout as `refs/t3/boat/<vm-id>/<branch>`. Nothing is pushed.
Uncommitted files stay on the VM.

## Shared options

**Model proxy** sends Claude and Codex in sandbox jobs and boat VMs through an
Anthropic- and OpenAI-compatible proxy. **Git identity** sets the name and
email on commits made there. Pushing to GitHub from a sandbox or VM stays off
until **Sandboxes and VMs may push** is on, even when a GitHub token can
write.
