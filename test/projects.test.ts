import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
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
    expect(projectFromCwd("/private/tmp/tmp.abc123", HOME)).toBe("/private/tmp/tmp.abc123");
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
