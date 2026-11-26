/**
 * Advice to unset Agent Rishi's internal `AGENT_RISHI_*` variables before running tests (#422). Agent
 * sessions don't inherit them (#191, #210; `packages/providers/test/agent-env.test.ts` keeps it
 * so), and checking for them stalled agents on an approval in the dark factory.
 */
export const UNSET_ADVICE =
  /\b(unset|clear|remove|delete|strip)\b[^.\n]{0,80}AGENT_RISHI_|env\s+-u\s+AGENT_RISHI_|Remove-Item\s+Env:\\?AGENT_RISHI/i;
