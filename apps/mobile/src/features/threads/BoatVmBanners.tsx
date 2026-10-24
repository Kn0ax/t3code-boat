import { useAtomValue } from "@effect/atom-react";
import {
  boatVmCopyContinuedHere,
  boatVmCopyRoute,
  boatVmEnvironmentLabel,
  boatVmLaunchBanner,
} from "@t3tools/client-runtime/boat-vms";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  boatVmThreadCopyOrigin,
  type BoatVmLaunchSnapshot,
  type BoatVmRepository,
  type EnvironmentId,
  type OrchestrationV2RunStatus,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState, type ReactNode } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  boatVmEnvironment,
  continueBoatVmCopy,
  launchBoatVm,
  readBoatVmLaunch,
  updateBoatVmLaunch,
  useBoatVmLaunch,
  useBoatVmPairings,
} from "../../state/boatVms";
import { useEnvironmentQuery } from "../../state/query";

function BoatVmCard(props: {
  readonly title: string;
  readonly description: string;
  readonly busy?: boolean;
  readonly failed?: boolean;
  readonly actions: ReactNode;
  /** A draft's composer controls already pad their banners. */
  readonly inset?: "draft";
}) {
  return (
    <View className={props.inset === "draft" ? "px-1 pb-2" : "px-4 pb-3"}>
      <View
        className={cn(
          "flex-row items-center gap-3 rounded-2xl border px-3.5 py-3",
          props.failed ? "border-danger-border bg-danger" : "border-border bg-card",
        )}
      >
        {props.busy ? <AppActivityIndicator size="small" /> : null}
        <View className="min-w-0 flex-1">
          <Text
            className={cn(
              "font-t3-medium text-sm",
              props.failed ? "text-danger-foreground" : "text-foreground",
            )}
            numberOfLines={2}
          >
            {props.title}
          </Text>
          <Text
            className={cn(
              "text-xs",
              props.failed ? "text-danger-foreground" : "text-foreground-muted",
            )}
            numberOfLines={3}
          >
            {props.description}
          </Text>
        </View>
        {props.actions}
      </View>
    </View>
  );
}

const NO_LAUNCHES: ReadonlyArray<BoatVmLaunchSnapshot> = [];
const NO_LAUNCHES_ATOM = Atom.make(NO_LAUNCHES).pipe(
  Atom.withLabel("mobile-boat-vm-launches:none"),
);

const environmentBoatVmLaunchesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<BoatVmLaunchSnapshot> =>
    Option.getOrElse(
      AsyncResult.value(get(boatVmEnvironment.launches({ environmentId, input: {} }))),
      () => NO_LAUNCHES,
    ),
  ).pipe(Atom.withLabel(`mobile-boat-vm-launches:${environmentId}`)),
);

/** Progress of a boat VM launch started from the composer `bannerKey` names, with Cancel. */
export function BoatVmLaunchBanner(props: {
  readonly bannerKey: string | null;
  readonly inset?: "draft";
}) {
  const entry = useBoatVmLaunch(props.bannerKey);
  // Subscribed only while the server still has stages to report.
  const launches = useAtomValue(
    entry !== undefined && (entry.phase === "launching" || entry.phase === "cancelling")
      ? environmentBoatVmLaunchesAtom(entry.hostEnvironmentId)
      : NO_LAUNCHES_ATOM,
  );
  const canCancel = useAtomValue(
    boatVmEnvironment.cancelLaunch.permissionAtom(entry?.hostEnvironmentId ?? null),
  );
  const key = props.bannerKey;
  if (key === null || entry === undefined) return null;

  const banner = boatVmLaunchBanner(entry, launches);
  const { launchId, hostEnvironmentId } = entry;
  const cancel = async () => {
    updateBoatVmLaunch(key, launchId, { phase: "cancelling" });
    const result = await runAtomCommand(
      appAtomRegistry,
      boatVmEnvironment.cancelLaunch,
      { environmentId: hostEnvironmentId, input: { launchId } },
      { reportFailure: false },
    );
    if (result._tag === "Success" && result.value.applied) return;
    // The launch finished first, or the cancel did not reach the server.
    if (readBoatVmLaunch(key)?.phase === "cancelling") {
      updateBoatVmLaunch(key, launchId, { phase: "launching" });
    }
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert("Could not cancel the boat VM launch", "Try again.");
    }
  };
  return (
    <BoatVmCard
      title={banner.title}
      description={banner.description}
      busy={!banner.failed}
      failed={banner.failed}
      {...(props.inset === undefined ? {} : { inset: props.inset })}
      actions={
        banner.failed ? (
          <Button
            label="Dismiss"
            tone="secondary"
            accessibilityLabel="Dismiss boat VM error"
            onPress={() => updateBoatVmLaunch(key, launchId, null)}
          />
        ) : banner.cancellable ? (
          <Button
            label="Cancel"
            tone="secondary"
            disabled={!canCancel}
            onPress={() => void cancel()}
          />
        ) : null
      }
    />
  );
}

/**
 * A copy of a boat VM thread points at the VM's thread while boat has the VM:
 * the banner opens that thread, starting or pairing the VM first, and sending
 * here is off. Once the VM is deleted, the banner and a send continue the
 * copy on a new VM instead (`continueOnNewVm`). The web composer does the same.
 */
export function useBoatVmCopy(input: {
  readonly thread: {
    readonly id: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly latestRun: { readonly status: OrchestrationV2RunStatus } | null;
  } | null;
  /** What the VM is resumed with: the copy's repository, or scratch. */
  readonly repository: BoatVmRepository | "scratch" | null;
  readonly bannerKey: string;
}): {
  readonly banner: ReactNode;
  readonly sendBlockedReason: string | null;
  /** Set while a send continues the copy on a new VM; resolves to whether it did. */
  readonly continueOnNewVm: ((message: string | null) => Promise<boolean>) | null;
} {
  const { thread } = input;
  const navigation = useNavigation();
  const pairings = useBoatVmPairings();
  const [opening, setOpening] = useState(false);
  // The copy lives with the environment that holds the boat key.
  const hostId =
    thread !== null && boatVmThreadCopyOrigin(thread.id) !== null ? thread.environmentId : null;
  const vms = useEnvironmentQuery(
    hostId === null ? null : boatVmEnvironment.list({ environmentId: hostId, input: {} }),
  );
  const loadedVms = vms.data?.available === true ? vms.data.vms : undefined;
  const route =
    thread === null
      ? null
      : boatVmCopyRoute({
          copyThreadId: thread.id,
          continuedHere: boatVmCopyContinuedHere(thread.latestRun),
          vms: loadedVms,
          pairings,
        });
  if (route === null || hostId === null || thread === null) {
    return { banner: null, sendBlockedReason: null, continueOnNewVm: null };
  }

  const openThread = (ref: ScopedThreadRef) =>
    navigation.navigate("Thread", {
      environmentId: String(ref.environmentId),
      threadId: String(ref.threadId),
    });

  if (route.vm === null) {
    const continueOnNewVm = (message: string | null) => {
      setOpening(true);
      return continueBoatVmCopy({
        hostEnvironmentId: hostId,
        repository: input.repository === "scratch" ? null : input.repository,
        bannerKey: input.bannerKey,
        copyThreadId: thread.id,
        message,
      })
        .then((continued) => {
          if (continued === null) return false;
          if (continued.warning !== undefined) {
            Dialog.alert(
              "The thread continues on a new boat VM, but not all of its work came along",
              continued.warning,
            );
          }
          openThread(continued.threadRef);
          return true;
        })
        .finally(() => setOpening(false));
    };
    return {
      banner: (
        <BoatVmCard
          title="This thread's boat VM was deleted"
          description="Continue on a new VM, with the commits brought home from the old one. Sending a message does the same."
          actions={
            <Button
              label="Continue on a new VM"
              tone="secondary"
              disabled={opening}
              onPress={() => void continueOnNewVm(null)}
            />
          }
        />
      ),
      sendBlockedReason: opening ? "Starting a new boat VM" : null,
      continueOnNewVm,
    };
  }

  const { vm } = route;
  const open = () => {
    if (route.environmentId !== null) {
      return openThread(scopeThreadRef(route.environmentId, route.threadId));
    }
    if (input.repository === null) return;
    setOpening(true);
    void launchBoatVm({
      hostEnvironmentId: hostId,
      sandboxId: vm.sandboxId,
      repository: input.repository === "scratch" ? null : input.repository,
      bannerKey: input.bannerKey,
    })
      .then((launched) => {
        if (launched !== null) {
          openThread(scopeThreadRef(launched.projectRef.environmentId, route.threadId));
        }
      })
      .finally(() => setOpening(false));
  };
  const label = boatVmEnvironmentLabel(vm.label);
  return {
    banner: (
      <BoatVmCard
        title={`This thread continues on ${label}`}
        description="This is a copy. Continue the conversation on the VM."
        actions={
          <Button
            label={
              route.environmentId !== null
                ? "Open on VM"
                : vm.status === "running"
                  ? "Connect and open"
                  : "Start VM and open"
            }
            tone="secondary"
            disabled={opening || (route.environmentId === null && input.repository === null)}
            onPress={open}
          />
        }
      />
    ),
    sendBlockedReason: `Continue on ${label}`,
    continueOnNewVm: null,
  };
}
