// Minimaler ZIP-Leser ohne Fremdbibliothek (Stored + Deflate), reicht für sevDesk-Exporte.
// Nutzt DecompressionStream('deflate-raw') – in aktuellen Browsern und Node ≥ 18 vorhanden.
const SIG_EOCD = 0x06054b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;

function decodeName(bytes, utf8) {
  try { return new TextDecoder(utf8 ? 'utf-8' : 'utf-8', { fatal: false }).decode(bytes); } catch (e) { return String.fromCharCode(...bytes); }
}

export function readZipEntries(buffer) {
  const buf = buffer instanceof ArrayBuffer ? buffer : (buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer);
  const dv = new DataView(buf); const u8 = new Uint8Array(buf);
  // End of central directory suchen (von hinten, Kommentar bis 64 KB)
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) { if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; } }
  if (eocd < 0) throw new Error('Keine gültige ZIP-Datei');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== SIG_CEN) break;
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = decodeName(u8.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name)) continue;
    out.push({ name, size, method, compSize, localOff, data: () => extract(buf, dv, localOff, method, compSize) });
  }
  return out;
}

async function extract(buf, dv, localOff, method, compSize) {
  if (dv.getUint32(localOff, true) !== SIG_LOC) throw new Error('ZIP-Eintrag beschädigt');
  const nameLen = dv.getUint16(localOff + 26, true), extraLen = dv.getUint16(localOff + 28, true);
  const start = localOff + 30 + nameLen + extraLen;
  const slice = buf.slice(start, start + compSize);
  if (method === 0) return new Uint8Array(slice);
  if (method !== 8) throw new Error('ZIP-Kompression ' + method + ' wird nicht unterstützt');
  if (typeof DecompressionStream === 'undefined') throw new Error('Browser unterstützt kein DecompressionStream');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([slice]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const baseName = (p) => String(p || '').split('/').pop();
