import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PositiveInt } from "./baseSchemas.ts";

/**
 * Cloud sandbox providers a sandbox job can use. The desktop IPC contract and
 * sandbox-core restate this list; the server checks they stay equal.
 */
export const SandboxJobProviderId = Schema.Literals(["boat"]);
export type SandboxJobProviderId = typeof SandboxJobProviderId.Type;
export const SandboxJobSize = Schema.Literals(["small", "medium", "large"]);
export type SandboxJobSize = typeof SandboxJobSize.Type;
export const BoatVmTailscaleMode = Schema.Literals(["off", "auth-key", "snapshot"]);
export type BoatVmTailscaleMode = typeof BoatVmTailscaleMode.Type;

/**
 * Keys a sandbox job needs. Secret fields like the other settings secrets:
 * the server keeps the values in its secret store, clients only ever see a
 * redaction marker for a saved one, and sending "" removes it.
 */
const SecretField = Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("")));

/** The boat API key sandbox jobs and boat VMs share. */
export const SandboxJobProviderKeys = Schema.Struct({
  boat: SecretField,
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));

/** Agent keys handed to every node as environment variables of these names. */
export const SandboxJobAgentKeys = Schema.Struct({
  ANTHROPIC_API_KEY: SecretField,
  CLAUDE_CODE_OAUTH_TOKEN: SecretField,
  OPENAI_API_KEY: SecretField,
  /** Lets nodes and boat VMs clone and pull private repositories. */
  GH_TOKEN: SecretField,
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));

/**
 * An Anthropic- and OpenAI-compatible proxy (CLIProxyAPI, LiteLLM) that nodes
 * and boat VMs send Claude Code and Codex through instead of the vendors'
 * APIs. Used only when both fields are set; the key is secret like the agent keys.
 */
export const SandboxModelProxySettings = Schema.Struct({
  baseUrl: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  key: SecretField,
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));

export const SandboxJobSettings = Schema.Struct({
  /** Off until the user turns it on: a job spends money on their provider account. */
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  maxActiveJobs: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(2))),
  /** Minutes without a run before a node is stopped (its disk is kept). */
  idleStopMinutes: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(15))),
  /** Hours a node may live before its work is collected and it is destroyed. */
  maxLifetimeHours: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(168))),
  defaultSize: SandboxJobSize.pipe(Schema.withDecodingDefault(Effect.succeed("small" as const))),
  providerKeys: SandboxJobProviderKeys,
  agentKeys: SandboxJobAgentKeys,
  /** Reusable Tailscale auth key boat VMs join the tailnet with. Secret like the keys above. */
  tailscaleAuthKey: SecretField,
  boatVmConnectionMode: Schema.Literals(["boat", "tailscale"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("boat" as const)),
  ),
  /**
   * How a boat VM joins the tailnet: not at all, with `tailscaleAuthKey`, or
   * through a snapshot that logs itself in. A Tailscale connection needs one of the last two.
   */
  boatVmTailscale: BoatVmTailscaleMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("off" as const)),
  ),
  /** Minutes without work before a boat VM archives itself. */
  boatVmIdleMinutes: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(30))),
  boatVmSize: SandboxJobSize.pipe(Schema.withDecodingDefault(Effect.succeed("small" as const))),
  /** Snapshot a new VM starts from when the repository has no `t3-<owner>-<repo>`; empty skips it. */
  boatVmBaseSnapshot: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("t3-base"))),
  /** boat environment new VMs attach for its logins and secrets; empty attaches none. */
  boatVmEnvironment: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  modelProxy: SandboxModelProxySettings,
  /** The identity commits made on nodes and boat VMs carry; empty leaves git's own. */
  gitUserName: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  gitUserEmail: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * Off by default for users who push only from their own machine: nodes and
   * boat VMs then cannot push to GitHub even with a write-scoped GH_TOKEN.
   */
  allowPush: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type SandboxJobSettings = typeof SandboxJobSettings.Type;

export const SandboxJobSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  maxActiveJobs: Schema.optionalKey(PositiveInt),
  idleStopMinutes: Schema.optionalKey(PositiveInt),
  maxLifetimeHours: Schema.optionalKey(PositiveInt),
  defaultSize: Schema.optionalKey(SandboxJobSize),
  providerKeys: Schema.optionalKey(
    Schema.Struct({
      boat: Schema.optionalKey(Schema.String),
    }),
  ),
  agentKeys: Schema.optionalKey(
    Schema.Struct({
      ANTHROPIC_API_KEY: Schema.optionalKey(Schema.String),
      CLAUDE_CODE_OAUTH_TOKEN: Schema.optionalKey(Schema.String),
      OPENAI_API_KEY: Schema.optionalKey(Schema.String),
      GH_TOKEN: Schema.optionalKey(Schema.String),
    }),
  ),
  tailscaleAuthKey: Schema.optionalKey(Schema.String),
  boatVmConnectionMode: Schema.optionalKey(Schema.Literals(["boat", "tailscale"])),
  boatVmTailscale: Schema.optionalKey(BoatVmTailscaleMode),
  boatVmIdleMinutes: Schema.optionalKey(PositiveInt),
  boatVmSize: Schema.optionalKey(SandboxJobSize),
  boatVmBaseSnapshot: Schema.optionalKey(Schema.String),
  boatVmEnvironment: Schema.optionalKey(Schema.String),
  modelProxy: Schema.optionalKey(
    Schema.Struct({
      baseUrl: Schema.optionalKey(Schema.String),
      key: Schema.optionalKey(Schema.String),
    }),
  ),
  gitUserName: Schema.optionalKey(Schema.String),
  gitUserEmail: Schema.optionalKey(Schema.String),
  allowPush: Schema.optionalKey(Schema.Boolean),
});
