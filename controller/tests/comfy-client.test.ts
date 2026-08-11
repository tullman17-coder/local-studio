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
          new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
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
    expect([...image.bytes]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(requests).toContain("POST http://boop:8188/prompt");
  });

  test("rejects invalid prompt identifiers before building a URL", async () => {
    const client = new ComfyClient({ baseUrl: "http://boop:8188" });
    await expect(Effect.runPromise(client.fetchImage("../secret", 0))).rejects.toThrow(
      "Invalid prompt id",
    );
  });

  test("surfaces ComfyUI execution failures without polling until timeout", async () => {
    const client = new ComfyClient({
      baseUrl: "http://boop:8188",
      pollIntervalMs: 0,
      timeoutMs: 50,
      fetcher: () =>
        Effect.succeed(
          jsonResponse({
            job: {
              status: {
                status_str: "error",
                completed: true,
                messages: [["execution_error", { exception_message: "CUDA OOM" }]],
              },
              outputs: {},
            },
          }),
        ),
    });
    await expect(Effect.runPromise(client.waitForImages("job"))).rejects.toThrow("CUDA OOM");
  });

  test("rejects active image content and oversized image responses", async () => {
    const historyPayload = {
      job: {
        outputs: {
          "7": { images: [{ filename: "image.png", subfolder: "", type: "output" }] },
        },
      },
    };
    const svgClient = new ComfyClient({
      baseUrl: "http://boop:8188",
      fetcher: (input) =>
        Effect.succeed(
          String(input).includes("/history/")
            ? jsonResponse(historyPayload)
            : new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
        ),
    });
    await expect(Effect.runPromise(svgClient.fetchImage("job", 0))).rejects.toThrow(
      "unsupported image type",
    );

    const mislabeledClient = new ComfyClient({
      baseUrl: "http://boop:8188",
      fetcher: (input) =>
        Effect.succeed(
          String(input).includes("/history/")
            ? jsonResponse(historyPayload)
            : new Response("<script>alert(1)</script>", {
                headers: { "content-type": "image/png" },
              }),
        ),
    });
    await expect(Effect.runPromise(mislabeledClient.fetchImage("job", 0))).rejects.toThrow(
      "invalid image payload",
    );

    const oversizedClient = new ComfyClient({
      baseUrl: "http://boop:8188",
      fetcher: (input) =>
        Effect.succeed(
          String(input).includes("/history/")
            ? jsonResponse(historyPayload)
            : new Response(new Uint8Array([1]), {
                headers: { "content-type": "image/png", "content-length": "33554433" },
              }),
        ),
    });
    await expect(Effect.runPromise(oversizedClient.fetchImage("job", 0))).rejects.toThrow(
      "image exceeds 33554432 bytes",
    );
  });

  test("times out when image response headers arrive but the body stalls", async () => {
    const historyPayload = {
      job: {
        outputs: {
          "7": { images: [{ filename: "image.png", subfolder: "", type: "output" }] },
        },
      },
    };
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      },
    });
    const client = new ComfyClient({
      baseUrl: "http://boop:8188",
      requestTimeoutMs: 20,
      fetcher: (input) =>
        Effect.succeed(
          String(input).includes("/history/")
            ? jsonResponse(historyPayload)
            : new Response(stalled, { headers: { "content-type": "image/png" } }),
        ),
    });
    await expect(Effect.runPromise(client.fetchImage("job", 0))).rejects.toThrow(
      "response body timed out",
    );
  });
});
