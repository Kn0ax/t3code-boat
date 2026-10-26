import {
  EnvironmentId,
  ThreadId,
  type BoatVmLaunchSnapshot,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  boatVmConnectionUpdates,
  boatVmCopyRoute,
  boatVmCopyTarget,
  boatVmDraftLaunch,
  boatVmInitialTransport,
  boatVmLabelUpdates,
  boatVmLaunchBanner,
  type BoatVmLaunchEntry,
  type BoatVmPairing,
  boatVmPairingInput,
  boatVmEnvironmentLabel,
  boatVmRunOnChoices,
  boatVmRunOnRow,
  boatVmSizeRows,
  boatVmsStillListedRunning,
  resolveBoatVmHostEnvironmentId,
  updateBoatVmLaunchEntries,
  withoutShadowedBoatVmCopies,
} from "./boatVms.ts";
import { BearerConnectionProfile } from "./connection/catalog.ts";
import { BearerConnectionTarget } from "./connection/model.ts";
import { scopeThreadRef } from "./environment/scoped.ts";

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

describe("boatVmsStillListedRunning", () => {
  const vm = (status: "running" | "stopping" | "stopped") => ({
    sandboxId: "bx_run",
    label: "acme/app",
    status,
  });

  it("names a failing VM environment while the list still says its VM runs", () => {
    expect(boatVmsStillListedRunning([recordedPairing], [vmEnvironment], [vm("running")])).toEqual([
      vmEnvironment,
    ]);
  });

  it("lets go once the list says the VM stops, or of a machine that is no VM", () => {
    for (const status of ["stopping", "stopped"] as const) {
      expect(boatVmsStillListedRunning([recordedPairing], [vmEnvironment], [vm(status)])).toEqual(
        [],
      );
    }
    expect(boatVmsStillListedRunning([], [vmEnvironment], [vm("running")])).toEqual([]);
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

describe("boatVmConnectionUpdates", () => {
  const entry = (
    httpBaseUrl: string,
    enabled: boolean,
    boatVm?: { readonly sandboxId: string; readonly hostEnvironmentId: EnvironmentId },
  ) => ({
    target: new BearerConnectionTarget({
      environmentId: vmEnvironment,
      label: "vm",
      connectionId: "c1",
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: "c1",
        environmentId: vmEnvironment,
        label: "vm",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace("https", "wss"),
        ...(boatVm === undefined ? {} : { boatVm }),
      }),
    ),
    enabled,
  });
  const recorded = (enabled: boolean) =>
    entry("https://box-node-0123.example.ts.net", enabled, {
      sandboxId: "bx_run",
      hostEnvironmentId: host,
    });
  const vm = (status: "running" | "stopped" | "destroyed") => [
    { sandboxId: "bx_run", label: "acme/app", status },
  ];

  it("switches a VM's connection off while it is stopped and on once it runs", () => {
    const seen = new Map();
    expect(boatVmConnectionUpdates([recorded(true)], vm("stopped"), host, seen)).toEqual([
      { type: "disable", environmentId: vmEnvironment },
    ]);
    expect(boatVmConnectionUpdates([recorded(false)], vm("running"), host, seen)).toEqual([
      { type: "enable", environmentId: vmEnvironment },
    ]);
  });

  it("keeps the user's switch until the VM's status changes", () => {
    const seen = new Map();
    expect(boatVmConnectionUpdates([recorded(true)], vm("running"), host, seen)).toEqual([]);
    expect(boatVmConnectionUpdates([recorded(false)], vm("running"), host, seen)).toEqual([]);
  });

  it("removes a recorded VM boat deleted, and only switches off one named by tailnet name", () => {
    expect(boatVmConnectionUpdates([recorded(true)], [], host, new Map())).toEqual([
      { type: "remove", environmentId: vmEnvironment },
    ]);
    expect(boatVmConnectionUpdates([recorded(true)], vm("destroyed"), host, new Map())).toEqual([
      { type: "remove", environmentId: vmEnvironment },
    ]);
    expect(
      boatVmConnectionUpdates(
        [entry("https://t3-vm-bxgone.example.ts.net", true)],
        [],
        host,
        new Map(),
      ),
    ).toEqual([{ type: "disable", environmentId: vmEnvironment }]);
  });

  it("leaves other machines and another host's VMs alone", () => {
    expect(
      boatVmConnectionUpdates([entry("https://laptop.example.ts.net", true)], [], host, new Map()),
    ).toEqual([]);
    expect(
      boatVmConnectionUpdates([recorded(true)], [], EnvironmentId.make("other"), new Map()),
    ).toEqual([]);
  });
});

describe("boatVmRunOnChoices", () => {
  it("shows a running paired VM as its machine and the rest as VMs to start", () => {
    const machines = [
      { environmentId: EnvironmentId.make("laptop"), label: "Laptop" },
      { environmentId: EnvironmentId.make("vm"), label: "box-node-1" },
    ];
    const choices = boatVmRunOnChoices(
      machines,
      [
        { sandboxId: "bx_run", label: "acme/app", status: "running" },
        { sandboxId: "bx_stop", label: "acme/app", status: "stopped" },
        { sandboxId: "bx_err", label: "acme/app", status: "error" },
      ],
      (environmentId) => (environmentId === "vm" ? "t3-vm-bxrun" : null),
    );
    expect(choices.machines.map((machine) => machine.label)).toEqual(["Laptop", "boat: acme/app"]);
    expect(choices.machines.map((machine) => machine.pairedBoatVm?.sandboxId)).toEqual([
      undefined,
      "bx_run",
    ]);
    expect(choices.vms.map((vm) => vm.sandboxId)).toEqual(["bx_stop"]);
  });
});

describe("boatVmRunOnRow", () => {
  it("names each VM by its repository and says it is a boat VM in its state", () => {
    // The list a manager returned for a running repository VM and a stopped No project VM.
    const vms = [
      { sandboxId: "bx_a", label: "acme/app", status: "running" },
      { sandboxId: "bx_b", label: "scratch", status: "stopped" },
    ] as const;
    const choices = boatVmRunOnChoices([], vms, () => null);
    expect(choices.vms.map((vm) => boatVmRunOnRow(vm))).toEqual([
      { title: "acme/app", note: "Boat VM · running", status: "running" },
      { title: "No project", note: "Boat VM · stopped, starts when picked", status: "stopped" },
    ]);
    expect(boatVmRunOnRow({ label: "acme/app", status: "creating" }).note).toBe(
      "Boat VM · starting",
    );
    expect(
      boatVmRunOnRow({ label: "acme/app", status: "stopping", task: "Fix the login" }).note,
    ).toBe("Boat VM · stopped, starts when picked · Fix the login");
  });

  it("says what New boat VM makes, with or without a project", () => {
    expect(boatVmRunOnRow(null)).toEqual({
      title: "New boat VM",
      note: "Creates a cloud VM for this repo",
    });
    expect(boatVmRunOnRow(null, { scratch: true }).note).toBe("Creates a cloud VM with no project");
  });

  it("lists every size for New boat VM, marking the host's default", () => {
    expect(boatVmSizeRows("medium")).toEqual([
      { size: "small", label: "Small", note: "2 vCPU · 4 GB" },
      { size: "medium", label: "Medium", note: "4 vCPU · 8 GB · default" },
      { size: "large", label: "Large", note: "8 vCPU · 16 GB" },
    ]);
  });

  it("names a paired No project VM the same way wherever it shows", () => {
    expect(boatVmEnvironmentLabel("scratch")).toBe("boat: No project");
    expect(boatVmEnvironmentLabel("acme/app")).toBe("boat: acme/app");
  });
});

describe("boatVmPairingInput", () => {
  const vm = {
    sandboxId: "bx_run",
    label: "acme/app",
    httpBaseUrl: "http://t3-vm-bxrun.example.ts.net",
    pairingCode: "code",
    workspaceRoot: "/home/user/work/app",
  };

  it("pairs at the VM's own origin without a relay", () => {
    expect(boatVmPairingInput(vm, host, null)).toEqual({
      boatVm: { sandboxId: "bx_run", hostEnvironmentId: host },
      label: "boat: acme/app",
      host: "http://t3-vm-bxrun.example.ts.net",
      pairingCode: "code",
    });
  });

  it("pairs through the host's relay, which needs the host's address", () => {
    const relayed = { ...vm, boatProxy: { token: "secret" } };
    expect(() => boatVmPairingInput(relayed, host, null)).toThrow(/Reconnect/);
    expect(boatVmPairingInput(relayed, host, "https://host.example.test")).toMatchObject({
      boatProxy: { sandboxId: "bx_run", token: "secret" },
    });
  });
});

const launchEntry = (overrides: Partial<BoatVmLaunchEntry> = {}): BoatVmLaunchEntry => ({
  launchId: "launch-1",
  hostEnvironmentId: EnvironmentId.make("host"),
  repositoryName: "ts-rust",
  newVm: true,
  phase: "launching",
  ...overrides,
});

const snapshot = (overrides: Partial<BoatVmLaunchSnapshot> = {}): BoatVmLaunchSnapshot => ({
  launchId: "launch-1",
  repositoryName: "ts-rust",
  stage: "installing",
  status: "running",
  ...overrides,
});

describe("boatVmLaunchBanner", () => {
  it("shows the stage of its own launch, not another one's", () => {
    const banner = boatVmLaunchBanner(launchEntry(), [
      snapshot({ launchId: "other", stage: "syncing" }),
      snapshot({ stage: "creating", detail: "t3-acme-ts-rust" }),
    ]);
    expect(banner).toEqual({
      title: "Starting a new boat VM for ts-rust",
      description: "Creating the VM from t3-acme-ts-rust",
      failed: false,
      cancellable: true,
    });
  });

  it("starts from the first stage before the server reports one", () => {
    expect(boatVmLaunchBanner(launchEntry({ newVm: false }), []).description).toBe(
      "Resuming the VM",
    );
  });

  it("connects after the launch returns and cannot be cancelled then", () => {
    const banner = boatVmLaunchBanner(launchEntry({ phase: "connecting" }), [snapshot()]);
    expect(banner.description).toBe("Connecting to the VM");
    expect(banner.cancellable).toBe(false);
  });

  it("shows a failure with its error", () => {
    const banner = boatVmLaunchBanner(
      launchEntry({ phase: "failed", error: "No Boat snapshot." }),
      [],
    );
    expect(banner).toMatchObject({ failed: true, description: "No Boat snapshot." });
  });

  it("names no repository for a launch without a project", () => {
    const banner = boatVmLaunchBanner(launchEntry({ repositoryName: null }), [
      snapshot({ stage: "preparing" }),
    ]);
    expect(banner).toMatchObject({
      title: "Starting a new boat VM",
      description: "Preparing workspace",
    });
  });
});

describe("updateBoatVmLaunchEntries", () => {
  it("leaves a newer launch from the same composer alone", () => {
    const entries = { "draft-a": launchEntry({ launchId: "second" }) };
    expect(updateBoatVmLaunchEntries(entries, "draft-a", "first", null)).toBe(entries);
    const failed = updateBoatVmLaunchEntries(entries, "draft-a", "second", {
      phase: "failed",
      error: "late",
    });
    expect(failed["draft-a"]).toMatchObject({ phase: "failed", error: "late" });
    expect(
      updateBoatVmLaunchEntries(failed, "draft-a", "second", { phase: "launching" })["draft-a"],
    ).not.toHaveProperty("error");
    expect(updateBoatVmLaunchEntries(entries, "draft-a", "second", null)).toEqual({});
  });
});

const primary = EnvironmentId.make("primary");
const laptop = EnvironmentId.make("laptop");
const hostCandidate = (environmentId: EnvironmentId, sandboxJobs: boolean) => ({
  environmentId,
  serverConfig: { environment: { capabilities: { sandboxJobs } } } as never,
});

describe("resolveBoatVmHostEnvironmentId", () => {
  it("uses the primary environment until one is chosen", () => {
    expect(
      resolveBoatVmHostEnvironmentId(null, primary, [
        hostCandidate(primary, true),
        hostCandidate(laptop, true),
      ]),
    ).toBe(primary);
  });

  it("uses the chosen environment while it can host boat VMs", () => {
    expect(
      resolveBoatVmHostEnvironmentId(laptop, primary, [
        hostCandidate(primary, true),
        hostCandidate(laptop, true),
      ]),
    ).toBe(laptop);
  });

  it("falls back to the primary when the chosen environment is gone or cannot host", () => {
    expect(resolveBoatVmHostEnvironmentId(laptop, primary, [hostCandidate(primary, true)])).toBe(
      primary,
    );
    expect(
      resolveBoatVmHostEnvironmentId(laptop, primary, [
        hostCandidate(primary, true),
        hostCandidate(laptop, false),
      ]),
    ).toBe(primary);
    expect(
      resolveBoatVmHostEnvironmentId(laptop, primary, [
        { environmentId: laptop, serverConfig: null },
      ]),
    ).toBe(primary);
  });
});
