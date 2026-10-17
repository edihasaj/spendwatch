import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { iso, line } from "./gateway-world";
import { tempDir } from "./tmp";

// `spendwatch watch` is an endless loop, so this runs the real command and reads its screens.
const ROOT = join(import.meta.dir, "..");
const SCREEN = "watching — ctrl-c to exit";
const row = (id: string, at: number) => JSON.stringify({ v: 1, at: iso(at), host: "studio", requestId: id, responseId: `resp_gl_${id}`, providerType: "copilot-subscription", provider: "copilot", model: "copilot/gpt", status: "completed", origin: "gateway", inputTokens: 100, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0, nanoAiu: 1e9, nanoAiuStatus: "complete" }) + "\n";

test("watch's first screen leaves a routed call waiting for its ledger row, and the next screen shows the ledger's bill", async () => {
  const root = tempDir("spendwatch-cli-watch-");
  const sessions = join(root, "codex", "sessions"); const state = join(root, "state");
  mkdirSync(sessions, { recursive: true }); mkdirSync(join(state, "usage"), { recursive: true });
  const now = Date.now();
  const ledger = join(state, "usage", `usage-${iso(now).slice(0, 7)}.jsonl`);
  // Another call, so the Copilot stream exists; the rollout's own record is 2 seconds old and its row is not written yet.
  writeFileSync(ledger, row("g1", now - 50_000));
  writeFileSync(join(sessions, "rollout-2026-10-15T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"),
    line({ timestamp: iso(now - 60_000), type: "session_meta", payload: { id: "s1", model_provider: "subscription_gateway" } })
    + line({ timestamp: iso(now - 60_000), type: "turn_context", payload: { model: "copilot/gpt" } })
    + line({ timestamp: iso(now - 2000), type: "token_usage_record", payload: { response_id: "resp_gl_g2", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } } }));
  writeFileSync(join(root, "config.json"), JSON.stringify([{ agent: "codex", path: sessions }, { agent: "copilot", path: join(root, "none.db") }, { agent: "gateway", path: state }]));

  const env: Record<string, string | undefined> = { ...process.env, SPENDWATCH_CONFIG: join(root, "config.json") };
  delete env.SPENDWATCH_GATEWAY_SOURCE; delete env.SPENDWATCH_GATEWAY_STATE;
  const child = Bun.spawn(["bun", join(ROOT, "src", "cli.ts"), "watch", "--interval", "100"], { cwd: ROOT, env, stdout: "pipe", stderr: "ignore" });
  let output = "";
  // One decoder for the whole stream: a character split between two chunks is not two replacement characters.
  const decoder = new TextDecoder();
  const reading = (async () => { for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true }); })();
  const screens = () => output.split(SCREEN).length - 1;
  const until = async (done: () => boolean) => { for (const deadline = Date.now() + 15_000; !done() && Date.now() < deadline;) await Bun.sleep(25); };
  try {
    await until(() => screens() >= 1);
    expect(screens()).toBe(1);
    const first = output;
    // The call is not billed anywhere while its row may still come.
    expect(first).not.toContain("not in this Mac's ledger");
    // The gateway appends the row; watch draws the ledger's bill and never the rollout's.
    appendFileSync(ledger, row("g2", now - 2000));
    await until(() => screens() >= 2);
    expect(screens()).toBeGreaterThanOrEqual(2);
    // Each screen ends with the marker line, so the text between the first two is the second screen.
    const [firstScreen, secondScreen] = output.split(SCREEN);
    expect(firstScreen).toContain("Copilot");
    expect(firstScreen).toContain("1 API calls");
    expect(secondScreen).toContain("Copilot");
    expect(secondScreen).toContain("2 API calls");
    await Bun.sleep(400);
    expect(output).not.toContain("not in this Mac's ledger");
    // Nothing changes from here on, so watch leaves the screen alone instead of repainting it on every tick.
    const settled = screens();
    await Bun.sleep(600);
    expect(screens()).toBe(settled);
  } finally {
    child.kill();
    await child.exited;
    await reading;
  }
}, 30_000);
