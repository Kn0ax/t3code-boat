import type { SandboxJobSettings } from "@t3tools/contracts";

/**
 * Environment variables the serve script reads to configure the agent CLIs
 * and git on every launch (see `bootstrapScripts.ts`).
 */
export const SANDBOX_ENV = {
  modelProxyBaseUrl: "T3_MODEL_PROXY_BASE_URL",
  /** Codex's provider entry names this variable as its `env_key`. */
  modelProxyKey: "T3_MODEL_PROXY_KEY",
  gitUserName: "T3_GIT_USER_NAME",
  gitUserEmail: "T3_GIT_USER_EMAIL",
  gitAllowPush: "T3_GIT_ALLOW_PUSH",
} as const;

/**
 * The proxy's root URL. Claude Code appends `/v1/messages` and the Codex
 * entry adds `/v1`, so a pasted `.../v1` is taken back to the root.
 */
const normalizeModelProxyBaseUrl = (baseUrl: string): string =>
  baseUrl.trim().replace(/\/+$/u, "").replace(/\/v1$/u, "").replace(/\/+$/u, "");

/** Whether nodes and VMs send their agents through the model proxy. */
export const sandboxModelProxyActive = (settings: SandboxJobSettings): boolean =>
  normalizeModelProxyBaseUrl(settings.modelProxy.baseUrl) !== "" &&
  settings.modelProxy.key.trim() !== "";

/** The environment every node and boat VM starts with. */
export function sandboxAgentEnvironment(
  settings: SandboxJobSettings,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(settings.agentKeys)
      .map(([name, value]) => [name, value.trim()] as const)
      .filter(([, value]) => value !== ""),
  );
  if (sandboxModelProxyActive(settings)) {
    const key = settings.modelProxy.key.trim();
    env[SANDBOX_ENV.modelProxyBaseUrl] = normalizeModelProxyBaseUrl(settings.modelProxy.baseUrl);
    env[SANDBOX_ENV.modelProxyKey] = key;
    // Claude Code sends ANTHROPIC_API_KEY as x-api-key to ANTHROPIC_BASE_URL;
    // the OAuth token is dropped so a vendor credential never reaches the proxy.
    env.ANTHROPIC_API_KEY = key;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  const gitUserName = settings.gitUserName.trim();
  const gitUserEmail = settings.gitUserEmail.trim();
  if (gitUserName !== "") env[SANDBOX_ENV.gitUserName] = gitUserName;
  if (gitUserEmail !== "") env[SANDBOX_ENV.gitUserEmail] = gitUserEmail;
  env[SANDBOX_ENV.gitAllowPush] = settings.allowPush ? "1" : "0";
  return env;
}
