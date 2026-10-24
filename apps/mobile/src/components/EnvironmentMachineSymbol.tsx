import { BOAT_LOGO_PATH, BOAT_LOGO_VIEW_BOX } from "@t3tools/client-runtime/boat-vms";
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";
import { SymbolView, type AppSymbolName } from "./ui/AppSymbol";

const ThemedSvg = withUniwind(Svg);

export const ENVIRONMENT_MACHINE_SYMBOLS = {
  server: "server.rack",
  cloud: "cloud",
  linux: "terminal",
  desktop: "desktopcomputer",
  laptop: "laptopcomputer",
  "mac-mini": "macmini",
  "mac-studio": "macstudio",
} as const satisfies Record<EnvironmentMachineKind, AppSymbolName>;

export const ENVIRONMENT_MACHINE_KIND_LABELS: Record<EnvironmentMachineKind, string> = {
  server: "Server",
  cloud: "Cloud VM",
  linux: "Linux/WSL",
  desktop: "Desktop",
  laptop: "Laptop",
  "mac-mini": "Mini PC",
  "mac-studio": "Workstation",
};

export function EnvironmentMachineSymbol(props: {
  readonly kind: EnvironmentMachineKind;
  readonly size: number;
  readonly tintColorClassName: string;
}) {
  return (
    <SymbolView
      accessibilityLabel={ENVIRONMENT_MACHINE_KIND_LABELS[props.kind]}
      name={ENVIRONMENT_MACHINE_SYMBOLS[props.kind]}
      size={props.size}
      tintColorClassName={props.tintColorClassName}
      type="monochrome"
    />
  );
}

/** Marks a boat VM, in place of the machine kind it would otherwise show. */
export function BoatVmSymbol(props: {
  readonly size: number;
  readonly tintColorClassName: string;
}) {
  return (
    <ThemedSvg
      accessibilityLabel="Boat VM"
      width={props.size}
      height={props.size}
      viewBox={BOAT_LOGO_VIEW_BOX}
      colorClassName={props.tintColorClassName}
    >
      <Path d={BOAT_LOGO_PATH} fill="currentColor" />
    </ThemedSvg>
  );
}
