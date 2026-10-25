import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { boatVmEnvironment } from "../../state/boatVms";
import { useEnvironmentQuery } from "../../state/query";
import { openSaveBoatSnapshotDialog } from "../SaveBoatSnapshotDialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

/** Saves one of the host's VMs, set up by hand, as snapshot `name`. */
export function SaveVmAsSnapshotMenu({
  environmentId,
  name,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
}) {
  // The VM list costs a boat call, so it loads only once the menu opens.
  const [opened, setOpened] = useState(false);
  const vmsQuery = useEnvironmentQuery(
    opened ? boatVmEnvironment.list({ environmentId, input: {} }) : null,
  );
  const vms =
    vmsQuery.data?.available === true
      ? vmsQuery.data.vms.filter((vm) => vm.status !== "destroyed")
      : undefined;
  return (
    <Menu onOpenChange={(open) => (open ? setOpened(true) : undefined)}>
      <MenuTrigger render={<Button size="xs" variant="outline" />}>Save from a VM…</MenuTrigger>
      <MenuPopup align="end">
        {vms === undefined ? (
          <MenuItem disabled>{vmsQuery.error ?? "Loading VMs…"}</MenuItem>
        ) : vms.length === 0 ? (
          <MenuItem disabled>No boat VMs yet</MenuItem>
        ) : (
          vms.map((vm) => (
            <MenuItem
              key={vm.sandboxId}
              onClick={() =>
                openSaveBoatSnapshotDialog({ hostEnvironmentId: environmentId, vm, name })
              }
            >
              {vm.task === undefined ? vm.label : `${vm.label} · ${vm.task}`}
            </MenuItem>
          ))
        )}
      </MenuPopup>
    </Menu>
  );
}
