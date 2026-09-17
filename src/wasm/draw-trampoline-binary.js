// Auto-generated from draw-trampoline.wat — DO NOT EDIT.
// Regenerate with: deno task wasm
// Binary size: 268 bytes (360 chars base64).

const WASM_BASE64 = "AGFzbQEAAAABQQhgAn19AGAEfX19fQBgBn19fX19fQBgAABgBn9/f319fwBgCH9/f319fX1/AGAKf39/fX19fX19fwBgBH9/f38AAkEFAmNiBm1vdmVUbwAAAmNiBmxpbmVUbwAAAmNiBnF1YWRUbwABAmNiB2N1YmljVG8AAgJjYgljbG9zZVBhdGgAAwMGBQQEBQYHBzwFB21vdmVfdG8ABQdsaW5lX3RvAAYMcXVhZHJhdGljX3RvAAcIY3ViaWNfdG8ACApjbG9zZV9wYXRoAAkKNgUIACADIAQQAAsIACADIAQQAQsMACADIAQgBSAGEAILEAAgAyAEIAUgBiAHIAgQAwsEABAECw==";

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function getWasmBytes() {
  return decodeBase64(WASM_BASE64);
}

// imports: the full WebAssembly import object, usually { env: { memory } }.
export function instantiate(imports) {
  const binary = decodeBase64(WASM_BASE64);
  const module = new WebAssembly.Module(binary);
  return new WebAssembly.Instance(module, imports);
}
