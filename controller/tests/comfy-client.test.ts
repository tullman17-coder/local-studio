import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { ComfyClient } from "../src/modules/images/comfy-client";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

describe("ComfyClient", () => {
  test("submits, waits for history, and fetches the selected output", async () => {
    const requests: string[] = [];
    let historyReads = 0;
    const fetcher = (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/prompt")) return Effect.succeed(jsonResponse({ prompt_id: "job-1" }));
      if (url.endsWith("/history/job-1")) {
        historyReads += 1;
        return Effect.succeed(
          jsonResponse(
            historyReads === 1
              ? {}
              : {
                  "job-1": {
                    outputs: {
                      "7": {
                        images: [
                          { filename: "image.png", subfolder: "local-studio", type: "output" },
                        ],
                      },
                    },
                  },
                },
          ),
        );
      }
      if (url.includes("/view?")) {
        return Effect.succeed(
          new Response(new Uint8Array([137, 80, 78, 71]), {
            headers: { "content-type": "image/png" },
          }),
        );
      }
      return Effect.fail(new Error(`Unexpected request: ${url}`));
    };
    const client = new ComfyClient({
      baseUrl: "http://boop:8188/",
      fetcher,
      pollIntervalMs: 0,
      timeoutMs: 1_000,
    });

    const promptId = await Effect.runPromise(
      client.submit({ "1": { class_type: "SaveImage", inputs: {} } }),
    );
    const images = await Effect.runPromise(client.waitForImages(promptId));
    const image = await Effect.runPromise(client.fetchImage(promptId, 0));

    expect(promptId).toBe("job-1");
    expect(images).toEqual([{ filename: "image.png", subfolder: "local-studio", type: "output" }]);
    expect(image.contentType).toBe("image/png");
    expect([...image.bytes]).toEqual([137, 80, 78, 71]);
    expect(requests).toContain("POST http://boop:8188/prompt");
  });

  test("rejects invalid prompt identifiers before building a URL", async () => {
    const client = new ComfyClient({ baseUrl: "http://boop:8188" });
    await expect(Effect.runPromise(client.fetchImage("../secret", 0))).rejects.toThrow(
      "Invalid prompt id",
    );
  });
});
