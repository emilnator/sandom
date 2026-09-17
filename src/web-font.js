const WOFF_SIGNATURE = 0x774f4646;
const WOFF2_SIGNATURE = 0x774f4632;

export async function decodeWebFont(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("decodeWebFont requires Uint8Array bytes");
  }
  if (bytes.byteLength < 4) return bytes;
  const signature = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0);
  if (signature !== WOFF_SIGNATURE && signature !== WOFF2_SIGNATURE) {
    return bytes;
  }
  const packageSpecifier = typeof Deno === "object"
    ? "npm:woff-lib@0.0.3/decode"
    : "woff-lib/decode";
  const { woffDecode, woff2Decode } = await import(packageSpecifier);
  return signature === WOFF_SIGNATURE
    ? await woffDecode(bytes)
    : await woff2Decode(bytes);
}
