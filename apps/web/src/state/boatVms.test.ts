import {
  BearerConnectionProfile,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type OrchestrationV2RunStatus } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import {
  boatVmCopyRoute,
  boatVmCopyTarget,
  boatVmDraftLaunch,
  boatVmInitialTransport,
  boatVmLabelUpdates,
  type BoatVmPairing,
  boatVmRunOnOptions,
  withoutShadowedBoatVmCopies,
} from "./boatVms";

const host = EnvironmentId.make("host");
const vmEnvironment = EnvironmentId.make("vm-env");
const recordedPairing: BoatVmPairing = {
  environmentId: vmEnvironment,
  recorded: { sandboxId: "bx_run", hostEnvironmentId: host },
  hostname: "box-node-0123456789abcdef",
};
const shell = (
  environmentId: EnvironmentId,
  id: string,
  latestRun: { readonly status: OrchestrationV2RunStatus } | null = null,
) => ({
  environmentId,
  id,
  latestRun,
});

describe("withoutShadowedBoatVmCopies", () => {
  const reachable = new Set([vmEnvironment]);

  it("hides a VM thread's copy while the VM's own thread is listed", () => {
    const vmThread = shell(vmEnvironment, "thread-1");
    const copy = shell(host, "import:boat-vm:bx_run:thread-1");
    const other = shell(host, "thread-2");
    expect(
      withoutShadowedBoatVmCopies([vmThread, copy, other], [recordedPairing], reachable),
    ).toEqual([vmThread, other]);
    // Not paired here, or the VM's thread is gone: the copy is the only row.
    expect(withoutShadowedBoatVmCopies([copy, other], [recordedPairing], reachable)).toEqual([
      copy,
      other,
    ]);
    expect(withoutShadowedBoatVmCopies([vmThread, copy], [], reachable)).toEqual([vmThread, copy]);
  });

  it("shows the copy instead of the VM's thread while the VM cannot be reached", () => {
    const vmThread = shell(vmEnvironment, "thread-1");
    const copy = shell(host, "import:boat-vm:bx_run:thread-1");
    expect(withoutShadowedBoatVmCopies([vmThread, copy], [recordedPairing], new Set())).toEqual([
      copy,
    ]);
  });

  it("keeps a copy that was continued here, and finds a VM paired by its tailnet name", () => {
    const vmThread = shell(vmEnvironment, "thread-1");
    const continued = shell(host, "import:boat-vm:bx_run:thread-1", { status: "completed" });
    expect(
      withoutShadowedBoatVmCopies([vmThread, continued], [recordedPairing], reachable),
    ).toEqual([vmThread, continued]);
    // A send here that only failed did not continue it.
    const failed = shell(host, "import:boat-vm:bx_run:thread-1", { status: "failed" });
    expect(withoutShadowedBoatVmCopies([vmThread, failed], [recordedPairing], reachable)).toEqual([
      vmThread,
    ]);
    const byName: BoatVmPairing = {
      environmentId: vmEnvironment,
      recorded: null,
      hostname: "t3-vm-bxrun",
    };
    const copy = shell(host, "import:boat-vm:bx_run:thread-1");
    expect(withoutShadowedBoatVmCopies([vmThread, copy], [byName], reachable)).toEqual([vmThread]);
  });

  it("returns the same list when nothing in it is a copy", () => {
    const threads = [shell(host, "thread-1")];
    expect(withoutShadowedBoatVmCopies(threads, [recordedPairing], reachable)).toBe(threads);
  });
});

describe("boatVmCopyTarget", () => {
  const target = scopeThreadRef(vmEnvironment, ThreadId.make("thread-1"));
  const copy = scopeThreadRef(host, ThreadId.make("import:boat-vm:bx_run:thread-1"));

  it("settles the copy on the VM's host while the VM cannot be reached", () => {
    const route = (canOperate: boolean, hasCopy: boolean) =>
      boatVmCopyTarget({
        target,
        canOperate,
        pairings: [recordedPairing],
        hasThread: (ref) => hasCopy && ref.threadId === copy.threadId,
      });
    expect(route(false, true)).toEqual(copy);
    expect(route(true, true)).toEqual(target);
    // Without a copy here the action stays on the VM and reports why it fails.
    expect(route(false, false)).toEqual(target);
  });

  it("leaves a thread alone on a VM paired before its host was recorded", () => {
    expect(
      boatVmCopyTarget({
        target,
        canOperate: false,
        pairings: [{ ...recordedPairing, recorded: null }],
        hasThread: () => true,
      }),
    ).toEqual(target);
  });
});

describe("boatVmCopyRoute", () => {
  const copyThreadId = "import:boat-vm:bx_run:thread-1";
  const vm = (status: "running" | "stopped" | "destroyed") => ({
    sandboxId: "bx_run",
    label: "acme/app",
    status,
  });

  it("opens the VM's thread while the VM runs and this client paired it", () => {
    expect(
      boatVmCopyRoute({
        copyThreadId,
        continuedHere: false,
        vms: [vm("running")],
        pairings: [recordedPairing],
      }),
    ).toEqual({ vm: vm("running"), threadId: "thread-1", environmentId: vmEnvironment });
  });

  it("starts or pairs the VM first when it is stopped or not paired here", () => {
    for (const [status, pairings] of [
      ["stopped", [recordedPairing]],
      ["running", []],
    ] as const) {
      expect(
        boatVmCopyRoute({ copyThreadId, continuedHere: false, vms: [vm(status)], pairings })
          ?.environmentId,
      ).toBeNull();
    }
  });

  it("continues on a new VM once the VM is gone", () => {
    const base = { copyThreadId, continuedHere: false, pairings: [recordedPairing] };
    const gone = { vm: null, threadId: "thread-1", environmentId: null };
    expect(boatVmCopyRoute({ ...base, vms: [vm("destroyed")] })).toEqual(gone);
    expect(boatVmCopyRoute({ ...base, vms: [] })).toEqual(gone);
  });

  it("is an ordinary thread until the VMs load, once continued here, or when it is no copy", () => {
    const base = { copyThreadId, continuedHere: false, pairings: [recordedPairing] };
    expect(boatVmCopyRoute({ ...base, vms: undefined })).toBeNull();
    expect(boatVmCopyRoute({ ...base, continuedHere: true, vms: [] })).toBeNull();
    expect(boatVmCopyRoute({ ...base, continuedHere: true, vms: [vm("running")] })).toBeNull();
    expect(boatVmCopyRoute({ ...base, copyThreadId: "thread-1", vms: [vm("running")] })).toBeNull();
  });
});

describe("boatVmInitialTransport", () => {
  it.each([
    ["http:", false, "http"],
    ["https:", false, "https"],
    ["file:", true, "http"],
    ["https:", true, "http"],
  ] as const)("uses %s with desktop=%s for %s", (protocol, desktop, expected) => {
    expect(boatVmInitialTransport(protocol, desktop)).toBe(expected);
  });
});

const machine = (id: string, label: string): EnvironmentOption => ({
  environmentId: EnvironmentId.make(id),
  projectId: null,
  label,
  isPrimary: false,
  machine: "cloud",
});

describe("boatVmRunOnOptions", () => {
  it("removes deleted snapshot connections when the refreshed inventory changes", () => {
    const environments = [machine("local", "Laptop"), machine("vm", "snapshot")];
    const hostnameOf = (id: EnvironmentId) => (id === "vm" ? "snapshot-bx-run" : null);
    const inventory = (sandboxIds: string[]) => ({
      sandboxIds,
      pairedVmOf: (id: EnvironmentId) =>
        id === "vm" ? { sandboxId: "bx_run", owned: true } : null,
    });
    const running = { sandboxId: "bx_run", label: "sample/app", status: "running" as const };
    expect(
      boatVmRunOnOptions(environments, [running], hostnameOf, undefined, inventory(["bx_run"])).map(
        (x) => x.environmentId,
      ),
    ).toEqual(["local", "vm", "boat-vm:new"]);
    expect(
      boatVmRunOnOptions(environments, [], hostnameOf, undefined, inventory([])).map(
        (x) => x.environmentId,
      ),
    ).toEqual(["local", "boat-vm:new"]);
  });

  it("checks saved sandbox IDs without hiding existing sandboxes or unrelated machines", () => {
    const environments = [
      machine("local", "Laptop"),
      machine("present", "box-node-1"),
      machine("gone", "box-node-2"),
      machine("desktop", "Separate account sandbox"),
    ];
    const pairedVmOf = (id: EnvironmentId) =>
      id === "present" || id === "gone" ? { sandboxId: `bx_${id}`, owned: true } : null;
    expect(
      boatVmRunOnOptions(environments, [], () => null, undefined, {
        sandboxIds: ["bx_present"],
        pairedVmOf,
      }).map((x) => x.environmentId),
    ).toEqual(["local", "present", "desktop", "boat-vm:new"]);
    expect(boatVmRunOnOptions(environments, [], () => null).map((x) => x.environmentId)).toEqual([
      "local",
      "present",
      "gone",
      "desktop",
      "boat-vm:new",
    ]);
  });

  it("matches a recorded VM by its ID, whichever environment launched it", () => {
    const options = boatVmRunOnOptions(
      [machine("relayed", "box-node-1")],
      [
        { sandboxId: "bx_host", label: "host", status: "running" },
        { sandboxId: "bx_run", label: "sample/app", status: "running" },
      ],
      // A relayed machine's URL names the environment that launched it.
      () => "snapshot-bx-host",
      undefined,
      { sandboxIds: [], pairedVmOf: () => ({ sandboxId: "bx_run", owned: false }) },
    );
    expect(options.map((option) => [option.environmentId, option.label])).toEqual([
      ["relayed", "boat: sample/app"],
      ["boat-vm:bx_host", "boat: host"],
      ["boat-vm:new", "New boat VM"],
    ]);
  });

  it("drops machines paired by tailnet name once boat no longer has their sandbox", () => {
    const hostnames: Record<string, string> = {
      gone: "snapshot-bx-gone",
      legacy: "t3-vm-bxlegacy",
      cli: "snapshot-bx-cli",
      other: "workstation",
    };
    const options = boatVmRunOnOptions(
      [
        machine("gone", "box-node-1"),
        machine("legacy", "box-node-2"),
        machine("cli", "box-node-3"),
        machine("other", "Workstation"),
      ],
      [],
      (environmentId) => hostnames[environmentId] ?? null,
      undefined,
      { sandboxIds: ["bx_cli"], pairedVmOf: () => null },
    );
    expect(options.map((option) => option.environmentId)).toEqual(["cli", "other", "boat-vm:new"]);
  });

  it("recognizes a snapshot hostname without duplicating its VM or losing resume", () => {
    const hostnames: Record<string, string> = {
      running: "snapshot-bx-run",
      stopped: "snapshot-bx-stop",
    };
    const options = boatVmRunOnOptions(
      [machine("running", "snapshot machine"), machine("stopped", "offline machine")],
      [
        { sandboxId: "bx_run", label: "sample/app", status: "running" },
        { sandboxId: "bx_stop", label: "sample/app", status: "stopped" },
      ],
      (environmentId) => hostnames[environmentId] ?? null,
    );
    expect(options.map((option) => [option.environmentId, option.label])).toEqual([
      ["running", "boat: sample/app"],
      ["boat-vm:bx_stop", "boat: sample/app (stopped)"],
      ["boat-vm:new", "New boat VM"],
    ]);
  });

  it("shows each VM once and preserves legacy machines without an owning inventory", () => {
    const hostnames: Record<string, string> = {
      running: "t3-vm-bxrun",
      stopped: "t3-vm-bxstop",
      deleted: "t3-vm-bxgone",
    };
    const options = boatVmRunOnOptions(
      [
        machine("laptop", "Laptop"),
        machine("running", "box-node-1"),
        machine("stopped", "box-node-2"),
        machine("deleted", "box-node-3"),
      ],
      [
        { sandboxId: "bx_run", label: "acme/app", status: "running" },
        { sandboxId: "bx_stop", label: "acme/app", status: "stopped" },
      ],
      (environmentId) => hostnames[environmentId] ?? null,
    );

    expect(options.map((option) => [option.environmentId, option.label])).toEqual([
      ["laptop", "Laptop"],
      ["running", "boat: acme/app"],
      ["deleted", "box-node-3"],
      ["boat-vm:bx_stop", "boat: acme/app (stopped)"],
      ["boat-vm:new", "New boat VM"],
    ]);
  });
});

describe("boatVmDraftLaunch", () => {
  const repositoryIdentity = {
    canonicalKey: "github.com/acme/app",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/app.git",
    },
    owner: "acme",
    name: "app",
  };

  it("launches a project draft with its repository", () => {
    expect(
      boatVmDraftLaunch({ isDraft: true, project: { repositoryIdentity }, isScratch: false }),
    ).toEqual({ remoteUrl: "https://github.com/acme/app.git", owner: "acme", name: "app" });
  });

  it("launches a No project draft without a repository", () => {
    expect(boatVmDraftLaunch({ isDraft: true, project: {}, isScratch: true })).toBe("scratch");
  });

  it.each([
    ["a project without a remote", { isDraft: true, project: {}, isScratch: false }],
    ["a thread that is no longer a draft", { isDraft: false, project: {}, isScratch: true }],
    ["a draft without a project", { isDraft: true, project: null, isScratch: false }],
  ] as const)("starts nothing for %s", (_, input) => {
    expect(boatVmDraftLaunch(input)).toBeNull();
  });
});

describe("boatVmLabelUpdates", () => {
  const entry = (
    label: string,
    httpBaseUrl: string,
    boatVm?: { readonly sandboxId: string; readonly hostEnvironmentId: EnvironmentId },
  ) => ({
    target: new BearerConnectionTarget({ environmentId: vmEnvironment, label, connectionId: "c1" }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: "c1",
        environmentId: vmEnvironment,
        label,
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace("https", "wss"),
        ...(boatVm === undefined ? {} : { boatVm }),
      }),
    ),
    enabled: true,
  });
  const vms = [{ sandboxId: "bx_run", label: "acme/app", status: "stopped" as const }];

  it("names a VM paired before pairing named it after the VM", () => {
    const byName = entry("box-node-0123", "https://t3-vm-bxrun.example.ts.net");
    expect(boatVmLabelUpdates([byName], vms)).toEqual([
      { environmentId: vmEnvironment, label: "boat: acme/app" },
    ]);
    const recorded = entry("box-node-0123", "https://box-node-0123.example.ts.net", {
      sandboxId: "bx_run",
      hostEnvironmentId: host,
    });
    expect(boatVmLabelUpdates([recorded], vms)).toEqual([
      { environmentId: vmEnvironment, label: "boat: acme/app" },
    ]);
  });

  it("leaves named VMs, other machines and deleted VMs alone", () => {
    expect(
      boatVmLabelUpdates([entry("boat: acme/app", "https://t3-vm-bxrun.example.ts.net")], vms),
    ).toEqual([]);
    expect(boatVmLabelUpdates([entry("laptop", "https://laptop.example.ts.net")], vms)).toEqual([]);
    expect(
      boatVmLabelUpdates(
        [entry("box-node-0123", "https://t3-vm-bxrun.example.ts.net")],
        [{ ...vms[0]!, status: "destroyed" }],
      ),
    ).toEqual([]);
  });
});
