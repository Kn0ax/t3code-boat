import { useLoadBalancedEnvironment } from "../../hooks/useLoadBalancedEnvironment";
import { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  type EnvironmentId,
  type BoatVmRepository,
  type ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toastManager } from "../ui/toast";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { type EnvironmentPresentation, useEnvironmentProviders } from "../../state/environments";
import { useProjects } from "../../state/entities";
import type { DraftSessionState } from "../../composerDraftStore";
import type { EnvironmentOption } from "../BranchToolbar.logic";
import type { useLaunchBoatVm } from "../../state/boatVms";

interface DraftEnvironmentRoutingInput {
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
  readonly envLocked: boolean;
  readonly automaticEnvironment: boolean;
  readonly logicalProjectEnvironments: ReturnType<typeof useLogicalProjectEnvironments>;
  // The machines a draft can switch to: the project's, plus any boat VMs.
  readonly runOnEnvironments: ReadonlyArray<EnvironmentOption>;
  readonly boatVmHostId: EnvironmentId | null;
  readonly boatVmDraft: BoatVmRepository | "scratch" | null;
  readonly boatVmLaunchKey: string;
  readonly launchBoatVm: ReturnType<typeof useLaunchBoatVm>;
  readonly environmentById: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly providersByEnvironment: ReturnType<typeof useEnvironmentProviders>;
  readonly loadBalancingSettings: {
    readonly loadBalancingWeights: Readonly<Record<string, number>>;
  };
  readonly referencedThreadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly activeProviderInstanceId: ProviderInstanceId | null;
  readonly selectedProvider: ProviderDriverKind;
  readonly composerHasAttachments: boolean;
  readonly activeProjectKey: string | null;
  readonly activeProjectIsScratch: boolean;
  readonly projectGroupingSettings: ReturnType<typeof selectProjectGroupingSettings>;
  readonly sendInFlightRef: { readonly current: boolean };
}

/**
 * Which machine an unsent draft runs on: automatic load balancing across the
 * project's machines, or a manual switch, which may first open a scratch
 * project on the target machine.
 */
export function useDraftEnvironmentRouting(input: DraftEnvironmentRoutingInput) {
  const {
    draftId,
    draftThread,
    envLocked,
    automaticEnvironment,
    logicalProjectEnvironments,
    runOnEnvironments,
    boatVmHostId,
    boatVmDraft,
    boatVmLaunchKey,
    launchBoatVm,
    environmentById,
    providersByEnvironment,
    loadBalancingSettings,
    referencedThreadContexts,
    activeProviderInstanceId,
    selectedProvider,
    composerHasAttachments,
    activeProjectKey,
    activeProjectIsScratch,
    projectGroupingSettings,
    sendInFlightRef,
  } = input;
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const allProjects = useProjects();
  const { openScratchProject } = useScratchProject();
  const needsLoadBalancing = automaticEnvironment && !draftThread?.loadBalancedEnvironmentId;
  const loadBalancingCandidates = needsLoadBalancing
    ? logicalProjectEnvironments
        .filter((candidate) => {
          const environment = environmentById.get(candidate.environmentId);
          return (
            environment?.connection.phase === "connected" &&
            (loadBalancingSettings.loadBalancingWeights[candidate.environmentId] ?? 50) > 0 &&
            referencedThreadContexts.every(
              (record) => record.environmentId === candidate.environmentId,
            ) &&
            providersByEnvironment
              .get(candidate.environmentId)
              ?.some(
                (provider) =>
                  (activeProviderInstanceId === null ||
                    provider.instanceId === activeProviderInstanceId) &&
                  provider.driver === selectedProvider &&
                  (environment.serverConfig?.settings
                    ? resolveProjectProviderInstanceEnabled(
                        environment.serverConfig.settings,
                        candidate.projectId,
                        provider.instanceId,
                      )
                    : provider.enabled) &&
                  provider.installed &&
                  provider.status !== "error" &&
                  provider.auth.status !== "unauthenticated" &&
                  provider.availability !== "unavailable",
              )
          );
        })
        .map((candidate) => candidate.environmentId)
    : [];
  const loadBalancing = useLoadBalancedEnvironment(
    loadBalancingCandidates,
    loadBalancingSettings.loadBalancingWeights,
  );
  useEffect(() => {
    if (!needsLoadBalancing || loadBalancing.pending || !draftId || sendInFlightRef.current) return;
    const target = logicalProjectEnvironments.find(
      (environment) => environment.environmentId === loadBalancing.environmentId,
    );
    if (!target?.projectId) return;
    setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(target.environmentId, target.projectId),
      environmentSelection: "auto",
      loadBalancedEnvironmentId: target.environmentId,
    });
  }, [
    needsLoadBalancing,
    loadBalancing.pending,
    loadBalancing.environmentId,
    draftId,
    logicalProjectEnvironments,
    sendInFlightRef,
    setDraftThreadContext,
  ]);
  const onAutoEnvironment = () => {
    if (envLocked || !draftId) return;
    if (composerHasAttachments) {
      toastManager.add({
        type: "warning",
        id: "load-balancing-attachments",
        title: "Keep attachments on this machine",
        description:
          "Remove attachments before choosing automatic routing, then attach them on the selected machine.",
      });
      return;
    }
    loadBalancing.refresh(
      logicalProjectEnvironments.map((environment) => environment.environmentId),
    );
    setDraftThreadContext(draftId, {
      environmentSelection: "auto",
      loadBalancedEnvironmentId: null,
      branch: null,
      worktreePath: null,
    });
  };
  const onAutoEnvironmentStable = useStableCallback(onAutoEnvironment);
  const autoEnvironmentLabel = automaticEnvironment
    ? draftThread?.loadBalancedEnvironmentId
      ? "Auto balance"
      : loadBalancing.pending
        ? "Checking machines…"
        : loadBalancing.failed
          ? "Auto balance unavailable"
          : "Auto balance"
    : undefined;

  // A change in flight belongs to the draft and project it started on.
  const environmentChangeScope = `${draftId ?? ""}:${activeProjectKey ?? ""}`;
  const environmentChangeRef = useRef<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const environmentChangeScopeRef = useRef("");
  useLayoutEffect(() => {
    environmentChangeScopeRef.current = environmentChangeScope;
  });
  // Leaving the scope, or unmounting, abandons a change still in flight.
  useLayoutEffect(
    () => () => {
      if (environmentChangeRef.current?.scope === environmentChangeScope) {
        environmentChangeRef.current = null;
      }
    },
    [environmentChangeScope],
  );
  const readPendingEnvironmentChange = () => {
    const pending = environmentChangeRef.current;
    return pending !== null && pending.scope === environmentChangeScopeRef.current ? pending : null;
  };
  // The busy state belongs to the request that set it, so an older request settling late
  // (abandoned, or superseded by a newer switch) can never clear a newer one's.
  const [busyEnvironmentChange, setBusyEnvironmentChange] = useState<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const isEnvironmentChanging = busyEnvironmentChange?.scope === environmentChangeScope;
  // A send pressed while the machine is still being prepared waits for it. Keyed by the
  // draft, which keeps its id when it moves to the new machine's project.
  const [queuedSend, setQueuedSend] = useState<{
    readonly draftId: string;
    readonly ready: boolean;
  } | null>(null);
  const queuedSendState =
    queuedSend === null || queuedSend.draftId !== draftId
      ? null
      : queuedSend.ready && !isEnvironmentChanging
        ? "ready"
        : "waiting";
  const queueSendAfterEnvironmentChange = () => {
    if (!isEnvironmentChanging || !draftId) return false;
    setQueuedSend({ draftId, ready: false });
    return true;
  };
  const clearQueuedSend = () => setQueuedSend(null);

  const onEnvironmentChange = (nextEnvironmentId: EnvironmentId) => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    const originalDraft = getDraftSession(draftId);
    if (!originalDraft || originalDraft.promotedTo) return;
    const target = runOnEnvironments.find((env) => env.environmentId === nextEnvironmentId);
    if (!target || target.disabledReason !== undefined) return;
    const request = { environmentId: target.environmentId, scope: environmentChangeScope };
    environmentChangeRef.current = request;
    setBusyEnvironmentChange(null);
    const finish = () => {
      if (environmentChangeRef.current === request) environmentChangeRef.current = null;
      setBusyEnvironmentChange((busy) => (busy === request ? null : busy));
      // Only a draft that reached the new machine sends what waited on it.
      setQueuedSend((queued) => (queued?.draftId === draftId && !queued.ready ? null : queued));
    };
    const markQueuedSendReady = () =>
      setQueuedSend((queued) =>
        queued?.draftId === draftId ? { ...queued, ready: true } : queued,
      );
    if (target.boatVm !== undefined) {
      if (boatVmHostId === null || boatVmDraft === null) return;
      setBusyEnvironmentChange(request);
      void launchBoatVm({
        hostEnvironmentId: boatVmHostId,
        sandboxId: target.boatVm.sandboxId,
        ...(target.boatVm.size === undefined ? {} : { size: target.boatVm.size }),
        repository: boatVmDraft === "scratch" ? null : boatVmDraft,
        bannerKey: boatVmLaunchKey,
      })
        .then((launched) => {
          if (launched === null) return;
          const { project, projectRef, warning } = launched;
          if (warning !== undefined) {
            toastManager.add({
              type: "warning",
              title: "The boat VM is ready, but its checkout was not updated",
              description: warning,
            });
          }
          const currentDraft = getDraftSession(draftId);
          if (
            environmentChangeRef.current !== request ||
            environmentChangeScopeRef.current !== request.scope ||
            sendInFlightRef.current ||
            !currentDraft ||
            currentDraft.promotedTo ||
            currentDraft.environmentId !== originalDraft.environmentId ||
            currentDraft.projectId !== originalDraft.projectId
          )
            return;
          markQueuedSendReady();
          // A "No project" draft moves to the VM's Scratch project the way it
          // moves to any other machine's.
          if (boatVmDraft === "scratch") {
            setLogicalProjectDraftThreadId(
              deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
              projectRef,
              draftId,
              { environmentSelection: "manual", loadBalancedEnvironmentId: null },
            );
            return;
          }
          setDraftThreadContext(draftId, {
            projectRef,
            environmentSelection: "manual",
            loadBalancedEnvironmentId: null,
          });
        })
        .finally(finish);
      return;
    }
    const retarget = (project: (typeof allProjects)[number]) => {
      const currentDraft = getDraftSession(draftId);
      if (
        environmentChangeRef.current !== request ||
        environmentChangeScopeRef.current !== request.scope ||
        sendInFlightRef.current ||
        !currentDraft ||
        currentDraft.promotedTo ||
        currentDraft.environmentId !== originalDraft.environmentId ||
        currentDraft.projectId !== originalDraft.projectId
      )
        return;
      markQueuedSendReady();
      const projectRef = scopeProjectRef(target.environmentId, project.id);
      if (activeProjectIsScratch) {
        setLogicalProjectDraftThreadId(
          deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
          projectRef,
          draftId,
          { environmentSelection: "manual", loadBalancedEnvironmentId: null },
        );
      } else {
        setDraftThreadContext(draftId, {
          projectRef,
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
        });
      }
    };
    if (target.projectId !== null) {
      const project = allProjects.find(
        (project) =>
          project.environmentId === target.environmentId && project.id === target.projectId,
      );
      if (project) retarget(project);
      finish();
      return;
    }
    setBusyEnvironmentChange(request);
    void openScratchProject(target.environmentId, "Could not switch machine")
      .then((project) => {
        if (project) retarget(project);
      })
      .finally(finish);
  };
  const onEnvironmentChangeStable = useStableCallback(onEnvironmentChange);

  return {
    needsLoadBalancing,
    loadBalancing,
    onAutoEnvironmentStable,
    autoEnvironmentLabel,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
    queuedSendState,
    queueSendAfterEnvironmentChange,
    clearQueuedSend,
  };
}
