import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { basename } from "node:path";

export async function persistManagedArchive(path: string): Promise<void> {
  const endpoint = process.env.SPENDWATCH_ARCHIVE_COMMIT_URL;
  const token = process.env.SPENDWATCH_ARCHIVE_COMMIT_TOKEN;
  if (!endpoint || !token || token.length < 32) {
    throw new Error("Managed pruning requires its durable archive transport");
  }
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
    throw new Error("The archive transport must be the local managed supervisor");
  }
  const bytes = statSync(path).size, descriptor = openSync(path, "r");
  const digest = createHash("sha256"), block = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, block);
      if (!count) break;
      digest.update(block.subarray(0, count));
    }
  } finally { closeSync(descriptor); }
  const sha256 = digest.digest("hex");
  const response = await fetch(url, {
    method: "PUT", body: Bun.file(path), signal: AbortSignal.timeout(20 * 60_000),
    headers: {
      Authorization: "Bearer " + token, "Content-Type": "application/octet-stream",
      "X-Spendwatch-Archive-Name": basename(path), "X-Spendwatch-SHA256": sha256,
    },
  });
  if (!response.ok) throw new Error("The archive is not durable; live history was retained");
  const proof = await response.json() as { durable?: boolean; bytes?: number; sha256?: string };
  if (proof.durable !== true || proof.bytes !== bytes || proof.sha256 !== sha256) {
    throw new Error("Archive readback did not match; live history was retained");
  }
}
