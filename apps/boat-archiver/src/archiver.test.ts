import { assert, describe, it } from "@effect/vitest";
import type { SandboxInfo, SandboxProviderShape } from "@t3tools/sandbox-core";
import { makeFakeSandboxProvider } from "@t3tools/sandbox-core/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { emptyState, runPass, type HomeServer } from "./archiver.ts";
import { decide, type VmThread } from "./decide.ts";
import { THREAD_SNAPSHOT_SCRIPT, THREADS_SCRIPT } from "./scripts.ts";

const nowMs = Date.parse("2026-10-20T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(nowMs - minutes * 60_000));
const thread = (id: string, fields: Partial<VmThread> = {}): VmThread => ({
  id,
  projectId: "project",
  status: "idle",
  archivedAt: null,
  snoozedUntil: null,
  latestUserMessageAt: minutesAgo(5),
  createdAt: minutesAgo(60),
  ...fields,
});
const rules = { hadThreads: true, copied: new Set<string>(), nowMs, idleMinutes: 30 };

describe("decide", () => {
  it("deletes a VM whose threads were all deleted, but not a fresh one", () => {
    assert.deepEqual(decide({ ...rules, threads: [] }), { action: "delete", copy: [] });
    assert.deepEqual(decide({ ...rules, threads: [], hadThreads: false }).action, "none");
  });

  it("copies archived threads home and deletes the VM once every thread is archived", () => {
    const archived = thread("a", { archivedAt: minutesAgo(1) });
    assert.deepEqual(decide({ ...rules, threads: [archived] }), {
      action: "delete",
      copy: [archived],
    });
    assert.deepEqual(decide({ ...rules, threads: [archived, thread("b")] }), {
      action: "none",
      copy: [archived],
    });
    assert.deepEqual(decide({ ...rules, threads: [archived], copied: new Set(["a"]) }).copy, []);
  });

  it("stops a VM whose threads are all snoozed or quiet, never one that is working", () => {
    const quiet = thread("q", { latestUserMessageAt: minutesAgo(45) });
    const snoozed = thread("s", { snoozedUntil: minutesAgo(-60) });
    const working = thread("w", { status: "running", latestUserMessageAt: minutesAgo(45) });
    const finished = thread("f", { status: "interrupted", latestUserMessageAt: minutesAgo(45) });
    assert.equal(decide({ ...rules, threads: [quiet, snoozed, finished] }).action, "stop");
    assert.equal(decide({ ...rules, threads: [quiet, thread("new")] }).action, "none");
    assert.equal(decide({ ...rules, threads: [quiet, working] }).action, "none");
  });
});

const vm = (sandboxId: string, status: SandboxInfo["status"]): SandboxInfo => ({
  ref: { providerId: "boat", sandboxId },
  status,
  label: "vm acme/app",
});
const project = { id: "project", remoteUrl: "https://github.com/acme/app.git" };
const snapshotOf = (fields: { archivedAt: string | null; deletedAt?: string | null }) =>
  JSON.stringify({
    projection: {
      thread: {
        id: "t1",
        projectId: "project",
        createdAt: minutesAgo(60),
        deletedAt: null,
        ...fields,
      },
    },
  });

/** A provider whose one VM lists `active` threads and answers snapshots with `snapshot`. */
const fakeProvider = (input: {
  readonly vms: ReadonlyArray<SandboxInfo>;
  readonly active: ReadonlyArray<VmThread>;
  readonly snapshot: string | "missing";
  readonly remoteUrl?: string | null;
  readonly calls: Array<string>;
}): SandboxProviderShape => ({
  ...makeFakeSandboxProvider({ id: "boat" }),
  list: () => Effect.succeed(input.vms),
  exec: (ref, exec) =>
    Effect.sync(() => {
      input.calls.push(`exec:${ref.sandboxId}`);
      if (exec.script === THREADS_SCRIPT) {
        const projects = [
          {
            ...project,
            remoteUrl: input.remoteUrl === undefined ? project.remoteUrl : input.remoteUrl,
          },
        ];
        return {
          exitCode: 0,
          stdout: JSON.stringify({ threads: input.active, projects }),
          stderr: "",
        };
      }
      if (exec.script === THREAD_SNAPSHOT_SCRIPT) {
        const stdout =
          input.snapshot === "missing" ? "missing" : "/home/user/.t3/archiver-thread.json";
        return { exitCode: 0, stdout, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }),
  readFile: () => Effect.succeed(new TextEncoder().encode(input.snapshot)),
  destroy: (ref) => Effect.sync(() => void input.calls.push(`destroy:${ref.sandboxId}`)),
  stop: (ref) => Effect.sync(() => void input.calls.push(`stop:${ref.sandboxId}`)),
});

describe("runPass", () => {
  it.effect("remembers a thread, then copies it home once archived and deletes its VM", () => {
    const calls: Array<string> = [];
    const imported: Array<string> = [];
    const home: HomeServer = {
      importThread: (input) =>
        Effect.sync(() => {
          calls.push("import");
          imported.push(`${input.originKey} ${input.repositoryRemoteUrl}`);
        }),
    };
    const vms = [
      vm("done", "running"),
      vm("parked", "stopped"),
      { ...vm("job", "running"), label: "sandbox job 1" },
    ];
    return Effect.gen(function* () {
      const first = yield* runPass({
        provider: fakeProvider({ vms, active: [thread("t1")], snapshot: "missing", calls }),
        home,
        state: emptyState,
        nowMs,
        idleMinutes: 30,
      });
      assert.deepEqual(first.state.threadsByVm, { done: ["t1"] });

      const second = yield* runPass({
        provider: fakeProvider({
          vms,
          active: [],
          snapshot: snapshotOf({ archivedAt: minutesAgo(1) }),
          calls,
        }),
        home,
        state: first.state,
        nowMs,
        idleMinutes: 30,
      });

      assert.deepEqual(imported, ["boat-vm:done:t1 https://github.com/acme/app.git"]);
      assert.isTrue(calls.indexOf("import") < calls.indexOf("destroy:done"));
      assert.notInclude(calls.join(" "), "parked");
      assert.notInclude(calls.join(" "), "job");
      assert.deepEqual(second.state, { threadsByVm: {}, copied: ["boat-vm:done:t1"] });
      assert.deepEqual(second.reports, [
        { sandboxId: "done", action: "delete", copied: ["t1"], problems: [] },
      ]);
    });
  });

  it.effect("deletes a VM whose remembered threads were all deleted", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { reports } = yield* runPass({
        provider: fakeProvider({
          vms: [vm("vm1", "running")],
          active: [],
          snapshot: "missing",
          calls,
        }),
        home: { importThread: () => Effect.die("nothing to copy") },
        state: { threadsByVm: { vm1: ["t1"] }, copied: [] },
        nowMs,
        idleMinutes: 30,
      });
      assert.equal(reports[0]?.action, "delete");
      assert.include(calls, "destroy:vm1");
    });
  });

  it.effect("keeps a VM when a copy fails", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { reports } = yield* runPass({
        provider: fakeProvider({
          vms: [vm("vm1", "running")],
          active: [],
          snapshot: snapshotOf({ archivedAt: minutesAgo(1) }),
          remoteUrl: null,
          calls,
        }),
        home: { importThread: () => Effect.die("unused") },
        state: { threadsByVm: { vm1: ["t1"] }, copied: [] },
        nowMs,
        idleMinutes: 30,
      });
      assert.equal(reports[0]?.action, "kept");
      assert.notInclude(calls, "destroy:vm1");
    });
  });

  it.effect("keeps tracking a thread whose snapshot could not be read", () => {
    const calls: Array<string> = [];
    const imported: Array<string> = [];
    const home: HomeServer = {
      importThread: (input) => Effect.sync(() => void imported.push(input.originKey)),
    };
    const vms = [vm("vm1", "running")];
    return Effect.gen(function* () {
      const first = yield* runPass({
        provider: fakeProvider({ vms, active: [], snapshot: "not json", calls }),
        home,
        state: { threadsByVm: { vm1: ["t1"] }, copied: [] },
        nowMs,
        idleMinutes: 30,
      });
      assert.equal(first.reports[0]?.action, "kept");

      const second = yield* runPass({
        provider: fakeProvider({
          vms,
          active: [],
          snapshot: snapshotOf({ archivedAt: minutesAgo(1) }),
          calls,
        }),
        home,
        state: first.state,
        nowMs,
        idleMinutes: 30,
      });
      assert.deepEqual(imported, ["boat-vm:vm1:t1"]);
      assert.equal(second.reports[0]?.action, "delete");
    });
  });

  it.effect("stops a VM whose threads have been quiet", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { reports } = yield* runPass({
        provider: fakeProvider({
          vms: [vm("vm1", "running")],
          active: [thread("t1", { latestUserMessageAt: minutesAgo(45) })],
          snapshot: "missing",
          calls,
        }),
        home: { importThread: () => Effect.die("unused") },
        state: emptyState,
        nowMs,
        idleMinutes: 30,
      });
      assert.equal(reports[0]?.action, "stop");
      assert.include(calls, "stop:vm1");
    });
  });
});
