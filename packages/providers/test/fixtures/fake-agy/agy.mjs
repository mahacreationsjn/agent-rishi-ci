// A scripted stand-in for Antigravity CLI's ACP server (`agy acp`, protocol version 1), in the
// shapes `agy` 1.5.18 uses (captured from a real session). No model is ever called.
//   agy.mjs --version   prints FAKE_AGY_VERSION (default 1.5.18)
//   agy.mjs acp ...     serves ACP on stdio; FAKE_AGY_NO_ACP=1 fails like an old CLI
// Like `agy`: sessions report `modes` and `models`, and config options for the model, the
// `thought_level` and the mode; `session/set_config_option` answers with every option.
// FAKE_AGY_AUTH=missing: `session/new` fails as signed out. FAKE_AGY_LOG: the process's
// arguments (`{ method: "argv", params }`), every message the client sends, and every answer
// to the agent's requests (`{ method: "answer:<method>", params }`), one JSON line each.
// FAKE_AGY_SCRIPT: a JSON file of steps each `session/prompt` runs in order (or
// `{ "prompts": [[...], [...]] }`: the steps of the first, second, ... prompt, the last repeating):
//   { "update": {...} }                   a session/update notification
//   { "request": "<method>", "params" }   an agent request, waiting for the client's answer
//   { "hang": true }                      wait for session/cancel (the prompt then ends cancelled)
//   { "awaitSteer": true }                wait for a prompt sent during this one (a steer)
//   { "stopReason": "...", "usage": {} }  how the prompt ends (default end_turn)
// Like `agy`, a prompt sent while one runs steers it: the running prompt answers `end_turn` at
// once (with the usage its script set so far), the work goes on, then the steer's own steps
// (the next script) run, and the newest prompt answers when all is done. While an agent request
// waits for its answer, such a prompt is refused with agy's error.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const env = process.env;
const record = (entry) => {
  if (env.FAKE_AGY_LOG) appendFileSync(env.FAKE_AGY_LOG, `${JSON.stringify(entry)}\n`);
};

if (args[0] === "--version") {
  console.log(env.FAKE_AGY_VERSION ?? "1.5.18");
  process.exit(0);
}
if (args[0] !== "acp" || env.FAKE_AGY_NO_ACP === "1") {
  console.error(`unknown command: ${args[0] ?? ""}`);
  process.exit(1);
}
record({ method: "argv", params: { args } });
// Without `--process-per-session`, `agy acp` reports no MCP support.
const perSession = args.includes("--process-per-session");

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const loaded = env.FAKE_AGY_SCRIPT
  ? JSON.parse(readFileSync(env.FAKE_AGY_SCRIPT, "utf8"))
  : [{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } }];
const scripts = Array.isArray(loaded) ? [loaded] : loaded.prompts;
let prompts = 0;
const waiting = new Map();
let nextId = 1000;
let session = "agy-1";
let cancel = () => {};
/** The running prompt: the id that answers when it ends, steers still to run, how it ends. */
let running;
let steered = () => {};
const current = { model: "gemini-4-hydrogen", thought_level: "high", mode: "default" };

const select = (id, name, category, values) => ({
  id,
  name,
  category,
  type: "select",
  currentValue: current[id],
  options: values.map(([value, label]) => ({ value, name: label })),
});
const configOptions = () => [
  select("model", "Model", "model", [
    ["gemini-4-hydrogen", "Gemini 4 Hydrogen"],
    ["gemini-3.8-flash", "Gemini 3.8 Flash"],
    ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
  ]),
  select("thought_level", "Thinking level", "thought_level", [
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
    ["xhigh", "Extra"],
  ]),
  select("mode", "Mode", "mode", [
    ["default", "Default"],
    ["accept-edits", "Accept edits"],
    ["auto", "Auto"],
    ["plan", "Plan"],
  ]),
];
const setup = () => ({
  modes: {
    currentModeId: current.mode,
    availableModes: [
      { id: "default", name: "Default" },
      { id: "accept-edits", name: "Accept edits" },
      { id: "auto", name: "Auto" },
      { id: "plan", name: "Plan" },
    ],
  },
  models: {
    currentModelId: `${current.model}-${current.thought_level}`,
    availableModels: [
      { modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
      { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    ],
  },
  configOptions: configOptions(),
  _meta: { antigravity: { tier: { name: "Google AI Pro", id: "g1-pro-tier" } } },
});

/** Send an agent request and wait for the answer. */
function ask(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, (answer) => {
      record({ method: `answer:${method}`, params: answer });
      resolve(answer);
    });
    send({ id, method, params: { sessionId: session, ...params } });
  });
}

const update = (u) => send({ method: "session/update", params: { sessionId: session, update: u } });

async function prompt(msg) {
  if (running) {
    if (waiting.size) {
      return send({
        id: msg.id,
        error: {
          code: -32603,
          message: `Can't add this prompt to session ${session}: the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again`,
        },
      });
    }
    send({ id: running.id, result: running.end });
    running.id = msg.id;
    running.steers++;
    return steered();
  }
  running = { id: msg.id, steers: 0, end: { stopReason: "end_turn" } };
  let cancelled = false;
  const hang = new Promise((resolve) => {
    cancel = () => {
      cancelled = true;
      resolve();
    };
  });
  const run = running;
  let scriptsLeft = 1;
  while (scriptsLeft-- > 0 && !cancelled) {
    const script = scripts[Math.min(prompts++, scripts.length - 1)];
    for (const step of script) {
      if (cancelled) break;
      if (step.update) update(step.update);
      else if (step.request) await ask(step.request, step.params ?? {});
      else if (step.hang) await hang;
      else if (step.awaitSteer) {
        if (run.steers === 0) await Promise.race([hang, new Promise((resolve) => (steered = resolve))]);
      } else if (step.stopReason) run.end = { stopReason: step.stopReason, ...(step.usage ? { usage: step.usage } : {}) };
    }
    scriptsLeft += run.steers;
    run.steers = 0;
    if (scriptsLeft > 0) run.end = { stopReason: "end_turn" };
  }
  running = undefined;
  send({ id: run.id, result: cancelled ? { stopReason: "cancelled" } : run.end });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) {
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    return resolve?.(msg.result ?? { error: msg.error });
  }
  record({ method: msg.method, params: msg.params });
  switch (msg.method) {
    case "initialize":
      return send({
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} },
            ...(perSession ? { mcpCapabilities: { http: true } } : {}),
          },
          agentInfo: { name: "Antigravity ACP Server", version: env.FAKE_AGY_VERSION ?? "1.5.18" },
          authMethods: [
            { id: "oauth-personal", name: "Log in with Google" },
            { id: "gemini-api-key", name: "Gemini API key" },
          ],
        },
      });
    case "authenticate":
      // Agent Rishi never sends it: sessions use the login the user already has.
      return send({ id: msg.id, error: { code: -32000, message: "authenticate is not expected" } });
    case "session/new":
      if (env.FAKE_AGY_AUTH === "missing") {
        return send({ id: msg.id, error: { code: -32000, message: "Authentication required" } });
      }
      return send({ id: msg.id, result: { sessionId: session, ...setup() } });
    case "session/load":
      session = msg.params.sessionId;
      update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old answer" } });
      return send({ id: msg.id, result: setup() });
    case "session/set_config_option": {
      const { configId, value } = msg.params;
      if (!(configId in current)) {
        return send({ id: msg.id, error: { code: -32602, message: `unknown option ${configId}` } });
      }
      current[configId] = value;
      if (configId === "mode") update({ sessionUpdate: "current_mode_update", currentModeId: value });
      return send({ id: msg.id, result: { configOptions: configOptions() } });
    }
    case "session/close":
      return send({ id: msg.id, result: {} });
    case "session/prompt":
      return void prompt(msg);
    case "session/cancel":
      return cancel();
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
