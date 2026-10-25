# Cloud sandboxes

Run work on [boat](https://boat.dev) with a boat API key. Create one with the
permissions T3 Code needs:

```sh
boat api-key create t3code --actions sandbox.create,sandbox.read,sandbox.update,sandbox.stop,sandbox.resume,sandbox.delete,exec,file.read,file.write,host,snapshot.read,snapshot.write,account.read,desktop
```

## Add a boat environment

In the desktop app:

1. Open **Settings → Connections → Add environment → Cloud sandbox**.
2. Paste your boat API key and choose a size.
3. Leave **Install coding agents** on, then choose **Create sandbox**.
4. Sign in to your agents on the sandbox.

Enable **Forward my GitHub token** if the sandbox needs your local `gh`
login. Only do this for sandboxes you trust with that token.

Use the environment's menu to start, stop, or delete it. Stopping keeps its
disk. **Remove from this device…** only removes the connection; it leaves
the sandbox running.

## Sandbox jobs

1. Open **Settings → Integrations → Sandbox jobs** and turn it on.
2. Save a boat API key and an agent key: Anthropic for Claude, OpenAI for Codex.
3. Ask an agent to run a task in a sandbox job.

Jobs get a copy of your workspace, including uncommitted changes, and keep
it between messages. Complete a job to bring its work back into the
repository without changing your checkout, or discard it.

These keys are saved on the server, separately from the desktop app's key.
Jobs work from any client.

## boat VMs

A boat VM runs its own T3 Code. Choose it in **Run on** to run a thread there.

### Set up

1. Save your boat API key in **Settings → Integrations → Sandbox jobs**.
2. Under **Boat VMs**, choose a **Base snapshot** and, optionally, a
   **Boat environment** with your agent logins.
3. Add a GitHub token if you use private repositories.

The server managing your VMs must stay running. Use a
[background service](background-service.md) on a machine that stays on.
You can choose this server under **Boat VMs → Managed by**.

### Start a thread

Open **Run on** in a new thread (the environment picker on mobile). Choose
an existing VM or **New boat VM**. Stopped VMs resume when selected.

New VMs use the repository's `t3-<owner>-<repo>` snapshot, then the
**Base snapshot** (`t3-base` by default), or a plain VM if neither exists.
To reuse your setup, run **Save boat VM as snapshot** from the command palette.

### Continue or bring work home

Your server keeps a copy of each VM thread. Choose **Open on VM** to
continue there. After the VM is deleted, sending a message in the copy
starts a new VM with the conversation and commits.

Run **Bring boat VM work home** from the command palette to fetch its
branches as `refs/t3/boat/<vm-id>/<branch>`. This does not push anything or
copy uncommitted files.

Idle VMs stop automatically. VMs with only settled or archived threads are
deleted after 3 days; reopening a thread keeps them. Deleting every thread
also deletes the VM. Commits are brought home before a running VM stops or
is deleted; uncommitted files are not backed up.

### Optional connections

- **Tailscale:** Not required with the default **Protected Boat URL**.
  To connect directly over your tailnet, configure **Tailscale** with an auth
  key or a snapshot that joins itself, then select **VM connection → Tailscale**.
  HTTPS web clients also need tailnet HTTPS certificates enabled.
- **Another machine:** Create a pairing code in the managing server's
  **Settings → Connections**. On the other machine, enter its URL and code
  under **Settings → Integrations → Sandbox jobs → Boat manager**, then
  choose **Link**.
- **Desktop access:** In a VM thread, choose **Boat desktop** from the
  panel's **+** menu. Keep the link private.

## Shared options

- **Model proxy:** Route Claude and Codex through a compatible proxy.
- **Git identity:** Set the name and email used for commits.
- **Sandboxes and VMs may push:** Allow pushing to GitHub.
