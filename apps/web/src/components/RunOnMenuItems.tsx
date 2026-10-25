import type { EnvironmentId } from "@t3tools/contracts";
import { ScaleIcon } from "lucide-react";
import type { ComponentProps } from "react";

import {
  type EnvironmentOption,
  newBoatVmSizeLabel,
  splitNewBoatVmOptions,
} from "./BranchToolbar.logic";
import { BoatVmIcon, EnvironmentOptionLabel } from "./EnvironmentMachineIcon";
import { MenuRadioGroup, MenuRadioItem, MenuSub, MenuSubPopup, MenuSubTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * The "Run on" choices in a menu: machines and existing boat VMs one per line,
 * and "New boat VM" in each size behind one entry.
 */
export function RunOnMenuItems({
  environments,
  environmentId,
  envLocked,
  autoEnvironmentLabel,
  onAutoEnvironment,
  onEnvironmentChange,
  subPopupProps,
}: {
  environments: readonly EnvironmentOption[];
  environmentId: EnvironmentId;
  envLocked: boolean;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  onEnvironmentChange?: ((environmentId: EnvironmentId) => void) | undefined;
  subPopupProps?: Omit<ComponentProps<typeof MenuSubPopup>, "children">;
}) {
  const value = autoEnvironmentLabel ? "auto" : environmentId;
  const onValueChange = (next: string) =>
    next === "auto" ? onAutoEnvironment?.() : onEnvironmentChange?.(next as EnvironmentId);
  const { listed, newBoatVms } = splitNewBoatVmOptions(environments);
  // A new VM's size reads its specs inline; any other entry's detail is its tooltip.
  const renderItem = (env: EnvironmentOption, size?: boolean) => {
    const detail = env.disabledReason ?? env.boatVmNote;
    const item = (
      <MenuRadioItem
        key={env.environmentId}
        disabled={
          envLocked ||
          (!onEnvironmentChange && env.environmentId !== environmentId) ||
          env.disabledReason !== undefined
        }
        value={env.environmentId}
        closeOnClick
        className="data-disabled:pointer-events-auto"
      >
        {size ? (
          <EnvironmentOptionLabel option={env} label={newBoatVmSizeLabel(env)} note={detail} />
        ) : (
          <EnvironmentOptionLabel option={env} />
        )}
      </MenuRadioItem>
    );
    return detail === undefined || size ? (
      item
    ) : (
      <Tooltip key={env.environmentId}>
        <TooltipTrigger render={item} />
        <TooltipPopup side="right">{detail}</TooltipPopup>
      </Tooltip>
    );
  };

  return (
    <>
      <MenuRadioGroup value={value} onValueChange={onValueChange}>
        {onAutoEnvironment && (
          <MenuRadioItem
            value="auto"
            disabled={envLocked}
            closeOnClick
            onClick={() => {
              if (autoEnvironmentLabel) onAutoEnvironment();
            }}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <ScaleIcon className="size-3" aria-hidden="true" />
              <span className="min-w-0 truncate">{autoEnvironmentLabel ?? "Auto balance"}</span>
            </span>
          </MenuRadioItem>
        )}
        {listed.map((env) => renderItem(env))}
      </MenuRadioGroup>
      {newBoatVms.length > 0 ? (
        <MenuSub>
          <MenuSubTrigger>
            <span className="flex min-w-0 items-center gap-1.5">
              <BoatVmIcon aria-hidden="true" className="size-3" />
              <span className="min-w-0 truncate">New boat VM</span>
            </span>
          </MenuSubTrigger>
          <MenuSubPopup {...subPopupProps}>
            <MenuRadioGroup value={value} onValueChange={onValueChange}>
              {newBoatVms.map((env) => renderItem(env, true))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
      ) : null}
    </>
  );
}
