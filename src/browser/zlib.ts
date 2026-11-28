/**
 * `node:zlib`'s deflateSync for the phone build, which only the fake pictures use (`fake-services.ts`). It stores rather
 * than compresses: stored deflate blocks, which every inflater reads, so a fake PNG is valid, only larger.
 */
export function deflateSync(input: Uint8Array) {
  const blocks = Math.max(1, Math.ceil(input.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + input.length + 4);
  out.set([0x78, 0x01]);
  let at = 2;
  for (let i = 0; i < blocks; i++) {
    const chunk = input.subarray(i * 65535, (i + 1) * 65535);
    out.set([i === blocks - 1 ? 1 : 0, chunk.length & 0xff, chunk.length >> 8, ~chunk.length & 0xff, (~chunk.length >> 8) & 0xff], at);
    out.set(chunk, at + 5);
    at += 5 + chunk.length;
  }
  let a = 1;
  let b = 0;
  for (const byte of input) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  new DataView(out.buffer).setUint32(at, ((b << 16) | a) >>> 0);
  return out;
}
