/**
 * Scripts the archiver runs inside a boat VM. They read the VM's own T3 over
 * loopback with a short-lived token that `t3` issues inside the VM, so no
 * credential ever leaves the VM. They use the runner and port the launch
 * steps already wrote (`@t3tools/sandbox-core` bootstrap scripts).
 */

const LOCAL_T3 = `set -eu
STATE_DIR="$HOME/.t3/ssh-launch/sandbox"
[ -x "$STATE_DIR/run-t3.sh" ] || { printf 'No T3 runner on this VM.\\n' >&2; exit 3; }
T3_PORT="$(cat "$STATE_DIR/port" 2>/dev/null || printf 3773)"
T3_TOKEN="$("$STATE_DIR/run-t3.sh" auth session issue --base-dir "$HOME/.t3" --scope orchestration:read --ttl 5m --token-only)"
export T3_PORT T3_TOKEN
`;

const FETCH_JS = `const get = async (path) => {
  const response = await fetch("http://127.0.0.1:" + process.env.T3_PORT + path, {
    headers: {
      authorization: "Bearer " + process.env.T3_TOKEN,
      "x-t3-orchestration-protocol": "2",
    },
  });
  if (!response.ok && response.status !== 404) throw new Error(path + " answered " + response.status);
  return response;
};`;

/**
 * Prints one JSON line: the VM's active threads with the fields the
 * lifecycle rules read, and each project's repository remote. The HTTP shell
 * leaves archived threads out; the archiver asks for those one by one.
 */
export const THREADS_SCRIPT = `${LOCAL_T3}node --input-type=module -e '
${FETCH_JS}
const shell = await (await get("/api/orchestration/shell")).json();
const pick = (thread) => ({
  id: thread.id,
  projectId: thread.projectId,
  status: thread.status,
  archivedAt: thread.archivedAt,
  snoozedUntil: thread.snoozedUntil ?? null,
  latestUserMessageAt: thread.latestUserMessageAt ?? null,
  createdAt: thread.createdAt,
});
process.stdout.write(JSON.stringify({
  threads: shell.threads.map(pick),
  projects: shell.projects.map((project) => ({
    id: project.id,
    remoteUrl: project.repositoryIdentity?.locator?.remoteUrl ?? null,
  })),
}));
'
`;

/**
 * Writes thread "$1"'s full snapshot to a file and prints the file's path, or
 * prints "missing" when the thread no longer exists.
 */
export const THREAD_SNAPSHOT_SCRIPT = `${LOCAL_T3}OUT="$HOME/.t3/archiver-thread.json"
node --input-type=module -e '
${FETCH_JS}
const { writeFile } = await import("node:fs/promises");
const response = await get("/api/orchestration/threads/" + encodeURIComponent(process.argv[1]));
if (response.status === 404) {
  process.stdout.write("missing");
} else {
  await writeFile(process.argv[2], await response.text());
  process.stdout.write(process.argv[2]);
}
' "$1" "$OUT"
`;

export const REMOVE_FILE_SCRIPT = `rm -f "$1"`;
