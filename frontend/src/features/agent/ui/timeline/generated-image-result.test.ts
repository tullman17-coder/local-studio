import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generatedImagesFromToolResult } from "./generated-image-result";

describe("generated image tool result", () => {
  test("accepts only local proxy image URLs", () => {
    assert.deepEqual(
      generatedImagesFromToolResult(
        JSON.stringify({
          kind: "generated-image",
          promptId: "job-1",
          images: [
            { url: "/api/proxy/v1/images/files/job-1/0", prompt: "violet lighthouse" },
            { url: "https://evil.example/image.png", prompt: "bad" },
          ],
        }),
      ),
      [{ url: "/api/proxy/v1/images/files/job-1/0", prompt: "violet lighthouse" }],
    );
  });

  test("ignores ordinary tool text", () => {
    assert.deepEqual(generatedImagesFromToolResult("generation failed"), []);
  });
});
