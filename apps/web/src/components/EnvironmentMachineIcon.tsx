import { BOAT_LOGO_PATH, BOAT_LOGO_VIEW_BOX } from "@t3tools/client-runtime/boat-vms";
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { CloudIcon, LaptopIcon, MonitorIcon, ServerIcon, type LucideProps } from "lucide-react";
import type { ComponentProps, FunctionComponent, SVGProps } from "react";
import type { EnvironmentOption } from "./BranchToolbar.logic";
import { LinuxIcon } from "./Icons";
import { Badge } from "./ui/badge";

function LucideLike(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  );
}

function MacMiniIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LucideLike {...props}>
      <rect width="20" height="8" x="2" y="8" rx="2" />
      <path d="M6 12h.01" />
    </LucideLike>
  );
}

function MacStudioIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LucideLike {...props}>
      <rect width="18" height="14" x="3" y="5" rx="2" />
      <path d="M7 15h.01M11 15h.01M15 15h.01" />
    </LucideLike>
  );
}

export function BoatVmIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox={BOAT_LOGO_VIEW_BOX}
      fill="currentColor"
      {...props}
    >
      <path d={BOAT_LOGO_PATH} />
    </svg>
  );
}

const ICON_BY_KIND: Record<EnvironmentMachineKind, FunctionComponent<LucideProps>> = {
  server: ServerIcon,
  cloud: CloudIcon,
  linux: LinuxIcon,
  desktop: MonitorIcon,
  laptop: LaptopIcon,
  "mac-mini": MacMiniIcon,
  "mac-studio": MacStudioIcon,
};

export const ENVIRONMENT_MACHINE_KIND_LABELS: Record<EnvironmentMachineKind, string> = {
  server: "Server",
  cloud: "Cloud VM",
  linux: "Linux/WSL",
  desktop: "Desktop",
  laptop: "Laptop",
  "mac-mini": "Mini PC",
  "mac-studio": "Workstation",
};

export function environmentMachineIcon(
  kind: EnvironmentMachineKind,
): FunctionComponent<LucideProps> {
  return ICON_BY_KIND[kind];
}

export function EnvironmentMachineIcon({
  kind,
  ...props
}: LucideProps & { readonly kind: EnvironmentMachineKind }) {
  const Icon = ICON_BY_KIND[kind];
  return <Icon {...props} />;
}

/** A "Run on" entry's icon: the boat mark for a boat VM, else its machine kind. */
export function EnvironmentOptionIcon(props: {
  readonly option: Pick<EnvironmentOption, "machine" | "boatVmNote"> | null;
  readonly className: string;
}) {
  return props.option?.boatVmNote !== undefined ? (
    <BoatVmIcon aria-label="Boat VM" className={props.className} />
  ) : (
    <EnvironmentMachineIcon kind={props.option?.machine ?? "server"} className={props.className} />
  );
}

const BOAT_VM_STATUS_BADGE_VARIANTS: Record<string, ComponentProps<typeof Badge>["variant"]> = {
  running: "success",
  starting: "info",
  unavailable: "error",
};

/** A "Run on" entry on one line: its icon, label, and an existing boat VM's state as a badge. */
export function EnvironmentOptionLabel(props: {
  readonly option: EnvironmentOption;
  readonly label?: string;
  /** Short text kept on the line, muted, after the label. */
  readonly note?: string | undefined;
}) {
  const status = props.option.boatVmStatus;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <EnvironmentOptionIcon option={props.option} className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{props.label ?? props.option.label}</span>
      {props.note !== undefined ? (
        <span className="shrink-0 text-muted-foreground text-xs">{props.note}</span>
      ) : null}
      {status !== undefined ? (
        <Badge size="sm" variant={BOAT_VM_STATUS_BADGE_VARIANTS[status] ?? "outline"}>
          {status}
        </Badge>
      ) : null}
    </span>
  );
}
