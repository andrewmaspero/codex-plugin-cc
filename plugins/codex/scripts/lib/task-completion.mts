/** Recovery applies only to fresh task jobs with an explicit output contract.
 * Prose contracts cannot be mechanically verified. A short final that says work
 * is still proceeding is positive evidence the contract is not yet satisfied;
 * short successful finals (including "Done") must remain untouched.
 */
export const MAX_AUTO_CONTINUES = 2;
export const EARLY_COMPLETION_NUDGE = "Subagent results have been delivered as input. Nobody sent you a message. Continue the task until every deliverable in the output contract exists and verification passes. Wait for all delegated work with the available wait tool, integrate its results, and report the verified deliverables.";

export function isSuspectEarlyCompletion(result, prompt) {
  const text = String(result.finalMessage ?? "").trim();
  return result.status === 0 && result.delegationObserved &&
    /<output_contract>[\s\S]*?\S[\s\S]*?<\/output_contract>/i.test(String(prompt ?? "")) &&
    text.length > 0 && text.length <= 300 &&
    !/(?:verification (?:passed|passes)|all (?:deliverables|files) (?:exist|verified)|task (?:is )?complete)/i.test(text) &&
    /(?:no response is needed|(?:i[’']?m|i am|we are|work is)\s+(?:proceeding|continuing)|(?:integration|commits?)\s+(?:is |are )?underway)/i.test(text);
}

export async function runWithCompletionGuard(run, { enabled, prompt, onRecovery, onExhausted }) {
  let result = await run(null);
  if (!enabled) return result;
  // Delegation may have drained before the next turn; retain the job's history.
  let delegated = Boolean(result.delegationObserved);
  for (let attempt = 0; isSuspectEarlyCompletion({ ...result, delegationObserved: delegated }, prompt); attempt += 1) {
    if (attempt === MAX_AUTO_CONTINUES) {
      onExhausted?.(result);
      return { ...result, status: 1, suspectEarlyCompletion: true,
        error: new Error(`suspect_early_completion: output contract remains unconfirmed after ${MAX_AUTO_CONTINUES} auto-continues.`) };
    }
    onRecovery?.(attempt + 1, result);
    result = await run({ threadId: result.threadId, prompt: EARLY_COMPLETION_NUDGE });
    delegated ||= Boolean(result.delegationObserved);
  }
  return result;
}
