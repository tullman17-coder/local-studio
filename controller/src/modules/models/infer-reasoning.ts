import { existsSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const NAME_HINT =
  /reason|thinking|\br1\b|deepseek|qwen3|glm-5|mimo|ornith|qwen35/;
const TEMPLATE_HINT = /enable_thinking|<think>|reasoning_content|<\/think>/i;
const ARCH_HINT = /qwen3|qwen35|deepseek|glm|mimo|gptoss|gpt-oss/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const blobHasReasoning = (blob: string): boolean =>
  NAME_HINT.test(blob.toLowerCase()) || TEMPLATE_HINT.test(blob);

const readJsonFile = (path: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const inferFromConfigDir = (dir: string): boolean | null => {
  const config = readJsonFile(join(dir, "config.json"));
  if (config) {
    const architectures = config["architectures"];
    const modelType = String(config["model_type"] ?? "");
    const arch =
      Array.isArray(architectures) && architectures.length > 0
        ? String(architectures[0])
        : modelType;
    if (ARCH_HINT.test(arch)) return true;
  }
  for (const name of ["tokenizer_config.json", "chat_template.jinja", "chat_template.json"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      if (TEMPLATE_HINT.test(readFileSync(path, "utf-8"))) return true;
    } catch {
      /* ignore */
    }
  }
  return null;
};

class Buf {
  constructor(
    private readonly fd: number,
    private offset = 0,
  ) {}
  read(n: number): Buffer {
    const buf = Buffer.alloc(n);
    let got = 0;
    while (got < n) {
      const r = readSync(this.fd, buf, got, n - got, this.offset);
      if (r <= 0) throw new Error("truncated");
      this.offset += r;
      got += r;
    }
    return buf;
  }
  u32(): number {
    return this.read(4).readUInt32LE(0);
  }
  u64(): number {
    return Number(this.read(8).readBigUInt64LE(0));
  }
  str(): string {
    const n = this.u64();
    if (n > 8_000_000) throw new Error("string too large");
    return this.read(n).toString("utf8");
  }
}

const skipGgufValue = (buf: Buf, type: number): void => {
  if (type === 8) {
    buf.str();
    return;
  }
  if (type === 9) {
    const at = buf.u32();
    const n = buf.u64();
    for (let i = 0; i < n; i += 1) skipGgufValue(buf, at);
    return;
  }
  const sizes: Record<number, number> = {
    0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8,
  };
  const size = sizes[type];
  if (!size) throw new Error(`unsupported gguf type ${type}`);
  buf.read(size);
};

const inferFromGguf = (path: string): boolean | null => {
  let fd = -1;
  try {
    fd = openSync(path, "r");
    const buf = new Buf(fd);
    if (buf.read(4).toString("utf8") !== "GGUF") return null;
    buf.u32();
    buf.u64();
    const nKv = buf.u64();
    for (let i = 0; i < Math.min(nKv, 256); i += 1) {
      const key = buf.str();
      const type = buf.u32();
      if (type === 8) {
        const value = buf.str();
        if (
          key === "tokenizer.chat_template" ||
          key === "general.architecture" ||
          key === "general.name" ||
          key === "general.basename"
        ) {
          if (blobHasReasoning(value) || ARCH_HINT.test(value)) return true;
        }
      } else {
        skipGgufValue(buf, type);
      }
    }
    return false;
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
};

export const inferReasoningCapability = (
  modelPath: string,
  identifiers: string[] = [],
): boolean => {
  if (blobHasReasoning(identifiers.filter(Boolean).join(" "))) return true;
  if (!modelPath) return false;
  if (modelPath.toLowerCase().endsWith(".gguf") && existsSync(modelPath)) {
    const fromGguf = inferFromGguf(modelPath);
    if (fromGguf) return true;
  }
  const dir = modelPath.toLowerCase().endsWith(".gguf") ? dirname(modelPath) : modelPath;
  if (existsSync(dir)) {
    const fromDir = inferFromConfigDir(dir);
    if (fromDir) return true;
  }
  return false;
};
