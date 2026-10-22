import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import { boatVmInitialTransport, boatVmRunOnOptions } from "./boatVms";

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
