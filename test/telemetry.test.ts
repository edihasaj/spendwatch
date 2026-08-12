import { describe, expect, test } from "bun:test";
import { reportOperationalError } from "../src/telemetry";

describe("operational telemetry", () => {
  test("sends only allowlisted operational metadata", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const sent = await reportOperationalError(
      "spendwatch.monitor.failure",
      new Error("Bearer secret in /private/repository"),
      {
        component: "capacity",
        status: "failed",
        repository: "/private/repository",
      },
      {
        dsn: "https://public-key@errors.example/35",
        environment: "production",
        release: "spendwatch@abc123",
        transport: async (input, init) => {
          request = { url: String(input), init };
          return new Response(null, { status: 200 });
        },
      },
    );

    expect(sent).toBe(true);
    expect(request?.url).toBe("https://errors.example/api/35/store/");
    const body = JSON.parse(String(request?.init?.body));
    expect(body.message).toBe("spendwatch.monitor.failure");
    expect(body.tags).toEqual({
      service: "spendwatch",
      error_type: "Error",
      component: "capacity",
      status: "failed",
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("private/repository");
    expect(body.exception).toBeUndefined();
    expect(body.request).toBeUndefined();
    expect(body.user).toBeUndefined();
  });

  test("fails closed without a valid DSN", async () => {
    expect(
      await reportOperationalError("spendwatch.failure", new Error(), {}, { dsn: "" }),
    ).toBe(false);
    expect(
      await reportOperationalError(
        "spendwatch.failure",
        new Error(),
        {},
        { dsn: "http://public@example/35" },
      ),
    ).toBe(false);
  });
});
