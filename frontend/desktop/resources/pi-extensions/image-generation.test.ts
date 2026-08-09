import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generationPreviewUrl } from "./image-generation";

describe("image generation extension", () => {
  test("maps a controller image URL through the authenticated frontend proxy", () => {
    assert.equal(
      generationPreviewUrl("/v1/images/files/job-1/0"),
      "/api/proxy/v1/images/files/job-1/0",
    );
  });

  test("rejects untrusted image URLs", () => {
    assert.throws(
      () => generationPreviewUrl("https://evil.example/image.png"),
      /Invalid image URL/,
    );
  });
});
