import type { OrchestrationProjectShell } from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";

/** The project whose repository identity matches `remoteUrl`, as clones on other machines name it. */
export const projectShellForRemote = <
  Shell extends Pick<OrchestrationProjectShell, "repositoryIdentity">,
>(
  shells: ReadonlyArray<Shell>,
  remoteUrl: string,
): Shell | undefined => {
  const key = normalizeGitRemoteUrl(remoteUrl);
  return shells.find(
    ({ repositoryIdentity: identity }) =>
      identity !== null &&
      identity !== undefined &&
      (identity.canonicalKey === key ||
        identity.origin?.canonicalKey === key ||
        normalizeGitRemoteUrl(identity.locator.remoteUrl) === key),
  );
};
