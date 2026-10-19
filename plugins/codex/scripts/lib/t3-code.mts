// T3 Code runs Claude Code through the Agent SDK and has its own orchestrator
// that can run Codex models as child tasks of the thread. Inside T3, Codex work
// should go through that orchestrator, not through this plugin's companion.

export const T3_CLI_PATH_ENV = "T3CODE_CLI_PATH";
export const T3_BUNDLE_ID = "com.t3tools.t3code";

export function isRunningInT3Code(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[T3_CLI_PATH_ENV]) || env.__CFBundleIdentifier === T3_BUNDLE_ID;
}

export const T3_CODE_SESSION_NOTICE = [
  "This Claude Code session runs inside T3 Code. Send work to Codex models (GPT-6 Luna, Sol 6.1, Astra) through T3's orchestrator, not this plugin:",
  "- Call the t3-code MCP tool orchestrator_capabilities to get the Codex provider instance id (normally \"codex\") and the model ids, then delegate_task with target { providerInstanceId, model, options: { reasoningEffort } }. Track the returned taskId with task_status and stop it with task_cancel.",
  "- Do not run codex-companion.mts, do not use the codex:codex-rescue subagent, and do not run /codex:* commands on your own initiative. Ignore the launch, watch, steer, and result steps of the codex-orchestrator skill; its model-choice rules still apply.",
  "- Exception: the user explicitly asks for the codex-fable plugin or types a /codex:* command."
].join("\n");
