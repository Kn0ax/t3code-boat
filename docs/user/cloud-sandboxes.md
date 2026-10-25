# Cloud sandboxes

T3 Code can run work on [boat](https://boat.dev). You need a boat API key. boat
runs every sandbox in the EU, and a running sandbox bills that account until
you stop or delete it.

The key must allow creating, resuming, and deleting sandboxes as well as running commands,
reading and writing files, hosting ports, reading and saving snapshots, and opening a VM's desktop. Boat's `full-sandbox` preset does
not include create or delete. With the Boat CLI, create a key with:

```sh
boat api-key create t3code --actions sandbox.create,sandbox.read,sandbox.update,sandbox.stop,sandbox.resume,sandbox.delete,exec,file.read,file.write,host,snapshot.read,snapshot.write,account.read,desktop
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
environment link to the one that manages them. The mobile app has no such
choice: it uses the new task's environment when that can, else the first
connected environment that is not itself a boat VM.

Ask an agent to run something in a sandbox job. The job gets a copy of the
workspace, including uncommitted changes, and keeps that disk between
messages. When it has been idle for the time you set, the sandbox stops and
starts again on the next message. A job ends only when it is completed, which
brings the work back into the repository without touching the checkout, or
when it is discarded. Each job bills the boat account until then.

If the boat key is missing, the error names **Settings → Integrations →
Sandbox jobs**.

## boat VMs

A boat VM is a cloud machine running its own T3 Code. Pick one in **Run on**
and the thread runs there, while your machine keeps a copy of the
conversation.

### Set up

1. Open **Settings → Integrations → Sandbox jobs** and save your boat API key.
2. Under **Boat VMs**, pick a **Base snapshot**. To give VMs your agent logins
   and secrets, also pick a **Boat environment**.
3. For private repositories, save a GitHub token there too. It is written to
   the VM when it starts and removed from its disk, so snapshots never carry
   it.

Only the server that holds the key keeps VMs running, so put it on a machine
that stays on. A VM started from the desktop app stops when that computer
sleeps or the app quits.

### Start a thread on a VM

In a new thread, open **Run on** (on mobile, the environment picker):

- **An existing VM** shows whether it is running or stopped. A stopped VM
  starts when you pick it.
- **New boat VM** asks for a size, then starts a VM for the thread's
  repository. A **No project** thread can use one too.

A new VM starts from your snapshot named `t3-<owner>-<repo>` if there is one,
else from the **Base snapshot** (`t3-base` by default), else from a plain VM.
The repository is checked out at `~/work/<repo>`.

To make a snapshot for a repository, set a VM up the way you like, then run
**Save boat VM as snapshot** from the command palette. It is named
`t3-<owner>-<repo>` by default, so the next VMs for that repository start from
it.

### Your copy of the thread

About every 3 minutes, the server copies each VM thread into its own project
for that repository, or into **No project**.

- While the VM exists, the copy is read-only. Choose **Open on VM** to keep
  going on the VM; a stopped VM starts first.
- Once the VM is deleted, just send a message in the copy. A new VM starts
  with the conversation and the commits from the old one.
- Settling, archiving, or deleting the copy counts as doing the same on the
  VM.

### When a VM stops or is deleted

| When                                                                                      | What happens                                                          |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| No new message for the idle time you set (30 minutes by default), or every thread snoozed | The VM stops and keeps its disk. Picking it again resumes it.         |
| Every thread settled or archived                                                          | The VM stops, and is deleted after 3 days unless you reopen a thread. |
| Every thread deleted                                                                      | The VM is deleted at the next check.                                  |

A VM you just started or resumed gets the full idle time before it can stop.
Before stopping or deleting a running VM, the server brings its commits home.
Uncommitted files and checkpoints are not kept.

### Bring work home

**Bring boat VM work home** in the command palette fetches the VM's branches
into your checkout as `refs/t3/boat/<vm-id>/<branch>`. Nothing is pushed, and
uncommitted files stay on the VM.

### Tailscale

By default (**VM connection → Protected Boat URL**), T3 reaches a VM through
the server that holds the key, so you don't need Tailscale.

To give a VM's ports and webhooks a direct address, set **Tailscale**:

- **Off**: the VM stays off your tailnet.
- **Auth key**: T3 joins it with a reusable, ephemeral auth key you save
  below.
- **Snapshot joins itself**: the snapshot logs in on its own. Make sure each
  new VM gets its own machine identity.

With either of the last two, **VM connection → Tailscale** connects to the VM
directly. Web clients opened over HTTPS also need HTTPS certificates turned on
for the tailnet.

### Use the VMs from another machine

1. On the server with the key, create a pairing code in **Settings →
   Connections**.
2. On the other machine, enter that server's URL and the code under
   **Settings → Integrations → Sandbox jobs → Boat manager**, then choose
   **Link**.

Its agents can then list VMs, start threads on them, and save snapshots, all
on that server. The link lasts 30 days. VMs on your tailnet link back by
themselves, so their agents can start VMs too, as long as the server has a
tailnet address (for example from Tailscale Serve).

### See the VM's screen

In a thread on a VM, choose **Boat desktop** from the panel's **+** menu (V).
The first open can take a minute. Treat the link like a password.

## Shared options

**Model proxy** sends Claude and Codex in sandbox jobs and boat VMs through an
Anthropic- and OpenAI-compatible proxy. **Git identity** sets the name and
email on commits made there. Pushing to GitHub from a sandbox or VM stays off
until **Sandboxes and VMs may push** is on, even when a GitHub token can
write.
