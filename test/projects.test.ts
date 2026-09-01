import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { realpathSync } from "node:fs";
import { Aggregator } from "../src/aggregate";
import { parseLine } from "../src/parse";
import { humanProject, mergeProjectRows, projectFromCwd } from "../src/projects";

const HOME = "/Users/developer";

describe("project naming", () => {
  test("keeps the real path shape a flattened directory name loses", () => {
    // The session directory for both of these is "…-tg-payroll-backend".
    expect(projectFromCwd("/Users/developer/Projects/tg/payroll-backend", HOME)).toBe("tg/payroll-backend");
    expect(projectFromCwd("/Users/developer/Projects/tg-payroll-backend", HOME)).toBe("tg-payroll-backend");
    expect(projectFromCwd("/Users/developer/Projects/dayshape/dayshape", HOME)).toBe("dayshape/dayshape");
  });

  test("collapses worktrees to the directory that holds them", () => {
    // Each of these is a throwaway checkout under a generated name.
    expect(projectFromCwd("/Users/developer/.paseo/worktrees/1itd0hyi/naive-cougar", HOME)).toBe(".paseo/worktrees");
    expect(projectFromCwd("/Users/developer/.paseo/worktrees/0qnz81m7/festive-kiwi", HOME)).toBe(".paseo/worktrees");
    expect(projectFromCwd("/Users/developer/Projects/dayshape/worktrees/feature", HOME)).toBe("dayshape/worktrees");
    // A worktree root inside a hidden directory: the repo wins over both cuts.
    expect(projectFromCwd("/Users/developer/Projects/dayshape/dayshape/.claude/worktrees/wt", HOME))
      .toBe("dayshape/dayshape");
  });

  test("stops at the checkout, wherever the checkout actually is", () => {
    // "owner/repo" and "repo/subdir" look identical as paths, so the presence
    // of a .git is what separates them.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "spendwatch-home-")));
    mkdirSync(join(home, "Projects", "spendwatch", "src"), { recursive: true });
    writeFileSync(join(home, "Projects", "spendwatch", ".git"), "gitdir: elsewhere");
    mkdirSync(join(home, "Projects", "oss", "paseo-baseline", "src"), { recursive: true });
    mkdirSync(join(home, "Projects", "oss", "paseo-baseline", ".git"), { recursive: true });

    const at = (...parts: string[]) => projectFromCwd(join(home, "Projects", ...parts), home);
    expect(at("spendwatch")).toBe("spendwatch");
    expect(at("spendwatch", "src")).toBe("spendwatch");
    expect(at("oss", "paseo-baseline")).toBe("oss/paseo-baseline");
    expect(at("oss", "paseo-baseline", "src")).toBe("oss/paseo-baseline");
  });

  test("assumes a two-deep checkout when the directory is gone", () => {
    // Nothing left to inspect, so the common "owner/repo" shape is the guess.
    expect(projectFromCwd("/Users/developer/Projects/tg/payroll-backend/src/accounts", HOME))
      .toBe("tg/payroll-backend");
    // Outside the workspace root there is no repository depth to assume.
    expect(projectFromCwd("/Users/developer/.local/share/oktapod/repo", HOME))
      .toBe(".local/share/oktapod/repo");
  });

  test("buckets every temporary directory together", () => {
    // macOS $TMPDIR, resolved through /private, with a fresh name per run.
    expect(projectFromCwd("/private/var/folders/vb/j5c/T/probeport-20260807T081414173Z-scout", HOME)).toBe("/tmp");
    expect(projectFromCwd("/private/tmp/autoreview-safety-final.JQpWCP", HOME)).toBe("/tmp");
    expect(projectFromCwd("/tmp/oktapod-live-x/task-001/oktapod-work", HOME)).toBe("/tmp");
    expect(projectFromCwd("/tmp", HOME)).toBe("/tmp");
    // Not temporary, despite the name.
    expect(projectFromCwd("/Users/developer/Projects/tmpl", HOME)).toBe("tmpl");
  });

  test("buckets a run directory stamped with an epoch", () => {
    // Each run of a tool invents its own name, so kept apart they outlive the
    // run as a row apiece.
    expect(projectFromCwd("/Users/developer/oktapod-goal-polish-1779439202/workspace", HOME)).toBe("~/scratch");
    expect(projectFromCwd("/Users/developer/oktapod-current-live-1779457937", HOME)).toBe("~/scratch");
    expect(projectFromCwd("/Users/developer/Projects/run-1779414813/out", HOME)).toBe("~/scratch");
    // A version or a year in the name is not a run stamp.
    expect(projectFromCwd("/Users/developer/Projects/analytics-2026", HOME)).toBe("analytics-2026");
    expect(projectFromCwd("/Users/developer/Projects/tg/payroll-v2", HOME)).toBe("tg/payroll-v2");
  });

  test("credits a dated scratch directory to the tool that made it", () => {
    expect(projectFromCwd("/Users/developer/Documents/Codex/2026-08-04/moonshot-reports", HOME)).toBe("Codex");
    expect(projectFromCwd("/Users/developer/Documents/Codex/2026-07-26/whe", HOME)).toBe("Codex");
  });

  test("attributes tool scratch to the repository holding it", () => {
    expect(projectFromCwd("/Users/developer/Projects/oktapod/.oktapod/reports/run-1/task-011/work", HOME))
      .toBe("oktapod");
    expect(projectFromCwd("/Users/developer/Projects/oktapod/.git/rebase-merge", HOME)).toBe("oktapod");
    // A leading dot is the project itself, not scratch inside one.
    expect(projectFromCwd("/Users/developer/.paseo", HOME)).toBe(".paseo");
  });

  test("names the workspace roots rather than inventing a project", () => {
    expect(projectFromCwd("/Users/developer/Projects", HOME)).toBe("~/Projects");
    expect(projectFromCwd("/Users/developer/Documents", HOME)).toBe("~/Documents");
    expect(projectFromCwd("/Users/developer", HOME)).toBe("~");
    expect(projectFromCwd("", HOME)).toBe("?");
  });

  test("reads another machine's home, and keeps paths outside one intact", () => {
    // Reports are rendered on a collector that is neither Mac.
    expect(projectFromCwd("/Users/someone-else/Projects/spendwatch", HOME)).toBe("spendwatch");
    expect(projectFromCwd("/home/baseadmin/Projects/spendwatch", HOME)).toBe("spendwatch");
    // Outside any home and not temporary: kept whole.
    expect(projectFromCwd("/opt/homebrew/src/tool", HOME)).toBe("/opt/homebrew/src/tool");
  });

  test("folds spellings of one case-insensitive directory into the busiest", () => {
    expect(mergeProjectRows([
      { project: "dayshape/Dayshape", tokens: 3, cost: 3 },
      { project: "dayshape/dayshape", tokens: 8, cost: 8 },
      { project: "ChirpGo", tokens: 5, cost: 5 },
    ])).toEqual([
      { project: "dayshape/dayshape", tokens: 11, cost: 11 },
      { project: "ChirpGo", tokens: 5, cost: 5 },
    ]);
  });

  test("the flattened fallback still works when a session recorded no cwd", () => {
    expect(humanProject("-Users-developer-Projects-sample-app")).toBe("sample-app");
    expect(humanProject("-Users-developer-Projects")).toBe("~/Projects");
  });
});

describe("project attribution from transcripts", () => {
  test("a Claude session is credited to its recorded cwd, not the folder name", () => {
    const home = homedir();
    const cwd = `${home}/Projects/tg/payroll-backend`;
    const aggregator = new Aggregator();
    // sources.ts can only offer the flattened directory name, which cannot tell
    // "tg/payroll-backend" from "tg-payroll-backend"; the cwd in the transcript can.
    const fold = aggregator.stream("session.jsonl", "tg-payroll-backend", "claude", "default");
    const line = JSON.stringify({
      type: "assistant", requestId: "req1", sessionId: "s1", cwd,
      timestamp: new Date().toISOString(),
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: "text", text: "ok" }],
      },
    });
    for (const event of parseLine(line)) fold(event);

    expect(aggregator.report().projects).toEqual([
      { project: "tg/payroll-backend", tokens: 110, cost: expect.any(Number) },
    ]);
  });
});
