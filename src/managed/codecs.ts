/** SQLite text can contain NUL and even historical blobs. Preserve both kinds. */
export function encodeSampleDetail(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return Buffer.concat([Buffer.from([0]), Buffer.from(value, "utf8")]);
  if (value instanceof Uint8Array) return Buffer.concat([Buffer.from([1]), Buffer.from(value)]);
  throw new Error("Unsupported sample detail type");
}
export function decodeSampleDetail(value: unknown): string | Uint8Array | null {
  if (value === null) return null;
  if (!(value instanceof Uint8Array) || !value.length) throw new Error("Missing sample detail codec tag");
  if (value[0] === 0) return new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(1));
  if (value[0] === 1) return Buffer.from(value.subarray(1));
  throw new Error("Unknown sample detail codec tag");
}
