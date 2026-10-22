import type { DesktopT3DataImportState } from "@t3tools/contracts";

export type OnboardingStep = "copy-data" | "connection" | "agents" | "boat" | "import";

export const ONBOARDING_STEP_LABELS: Readonly<Record<OnboardingStep, string>> = {
  "copy-data": "Copy data",
  connection: "Connect",
  agents: "Agents",
  boat: "Boat",
  import: "Projects",
};

export function resolveOnboardingSteps(input: {
  /** `null` outside the desktop app, or when its shell cannot copy data. */
  readonly dataImport: DesktopT3DataImportState | null;
  readonly boatSupported: boolean;
}): readonly OnboardingStep[] {
  const imported = input.dataImport?.imported === true;
  return [
    ...(input.dataImport?.available === true && !imported ? (["copy-data"] as const) : []),
    "connection",
    "agents",
    ...(input.boatSupported ? (["boat"] as const) : []),
    // Copied projects are already there; scanning for more would duplicate them.
    ...(imported ? [] : (["import"] as const)),
  ];
}

export function nextOnboardingStep(
  steps: readonly OnboardingStep[],
  current: OnboardingStep,
): OnboardingStep | null {
  const index = steps.indexOf(current);
  return index === -1 ? null : (steps[index + 1] ?? null);
}
