import { ComposerControl, ComposerControlChevron } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import type { EnvironmentId } from "@t3tools/contracts";
import { PlusIcon, ScaleIcon } from "lucide-react";
import { memo } from "react";

import { ADD_TO_MACHINE_LABEL_CLASS, type EnvironmentOption } from "./BranchToolbar.logic";
import { EnvironmentOptionIcon } from "./EnvironmentMachineIcon";
import { RunOnMenuItems } from "./RunOnMenuItems";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { useRefreshBoatVmsOnOpen } from "../state/boatVms";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

interface BranchToolbarEnvironmentSelectorProps {
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onAddToMachine?: (() => void) | undefined;
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  onAddToMachine,
}: BranchToolbarEnvironmentSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.host",
  );
  const activeEnvironment =
    availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  const refreshBoatVms = useRefreshBoatVmsOnOpen(availableEnvironments);

  // The static label carries the xs control's height (h-7 sm:h-6) as well as
  // its padding: the composer context strip has no min-height of its own, and
  // the glass seam joining it to the composer assumes a fixed strip height, so
  // a shorter label would drag the seam out of line whenever this label is the
  // only thing in the strip.
  if (envLocked || (onEnvironmentChange === undefined && onAddToMachine === undefined)) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
        data-composer-context-control
      >
        <EnvironmentOptionIcon option={activeEnvironment} className="size-3 shrink-0" />
        <ComposerContextLabel>{activeEnvironment?.label ?? "Run on"}</ComposerContextLabel>
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>{activeEnvironment?.label ?? "Run on"}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu modal={false} onOpenChange={refreshBoatVms}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<ComposerControl size="xs" />}
              className="min-w-0 max-w-full"
              aria-label="Run on"
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          {autoEnvironmentLabel ? (
            <ScaleIcon className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <EnvironmentOptionIcon option={activeEnvironment} className="size-3 shrink-0" />
          )}
          <ComposerContextLabel>
            {autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"}
          </ComposerContextLabel>
          <ComposerControlChevron size="xs" />
        </TooltipTrigger>
        <TooltipPopup>
          {autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"}
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="top" {...composerFloatingLayerProps}>
        <MenuGroup>
          <MenuGroupLabel>Run on</MenuGroupLabel>
          <RunOnMenuItems
            environments={availableEnvironments}
            environmentId={environmentId}
            envLocked={envLocked}
            autoEnvironmentLabel={autoEnvironmentLabel}
            onAutoEnvironment={onAutoEnvironment}
            onEnvironmentChange={onEnvironmentChange}
            subPopupProps={composerFloatingLayerProps}
          />
          {onAddToMachine ? (
            <MenuItem onClick={onAddToMachine}>
              <span className={ADD_TO_MACHINE_LABEL_CLASS}>
                <PlusIcon aria-hidden="true" className="size-3" />
                Add to another machine
              </span>
            </MenuItem>
          ) : null}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});
