const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(input: string): Uint8Array {
  const data = new TextEncoder().encode(input);
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (data.length * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(data.length / 2 ** 29), true);

  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let off = 0; off < padded.length; off += 64) {
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) [f, g] = [(b & c) | (~b & d), i];
      else if (i < 32) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16];
      else if (i < 48) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16];
      const s = S[((i >> 4) << 2) | (i & 3)];
      const sum = (a + f + K[i] + view.getUint32(off + g * 4, true)) | 0;
      [a, d, c] = [d, c, b];
      b = (b + ((sum << s) | (sum >>> (32 - s)))) | 0;
    }
    [a, b, c, d].forEach((v, j) => (state[j] = (state[j] + v) | 0));
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  state.forEach((w, i) => outView.setUint32(i * 4, w >>> 0, true));
  return out;
}

export function md5Base64(input: string): string {
  return btoa(String.fromCharCode(...md5(input)));
}
