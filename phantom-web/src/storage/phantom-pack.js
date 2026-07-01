'use strict';

/**
 * Phantom-Pack — .phantom 打包/拆包工具
 * 
 * 将 Manifest (.ptm) + 所有加密分片打包为单一 .phantom 文件，
 * 便于通过邮箱等通道传输。
 * 
 * 文件格式：
 * ┌──────────────────────────────────┐
 * │ Magic: "PHNT" (4 bytes)         │
 * │ Version: 0x01 (1 byte)          │
 * │ Manifest Length: Uint32 LE      │
 * │ Manifest Data (variable)        │
 * │ Chunk Count: Uint32 LE          │
 * │ For each chunk:                 │
 * │   ├─ Chunk ID Len: Uint16 LE    │
 * │   ├─ Chunk ID (UTF-8)           │
 * │   ├─ Chunk Data Len: Uint32 LE  │
 * │   └─ Chunk Data                 │
 * └──────────────────────────────────┘
 */

const PACK_MAGIC = 0x50484E54; // "PHNT"
const PACK_VERSION = 0x01;

/**
 * 打包 Manifest + Chunks 为 .phantom 文件
 * @param {Uint8Array} manifestData - .ptm 二进制数据
 * @param {Map<string, Uint8Array>} chunks - chunkId → 加密数据
 * @returns {Blob}
 */
function packPhantom(manifestData, chunks) {
    const entries = Array.from(chunks.entries());
    let size = 4 + 1 + 4 + manifestData.length + 4;
    for (const [id, data] of entries) {
        const idBytes = new TextEncoder().encode(id);
        size += 2 + idBytes.length + 4 + data.length;
    }

    const buf = new ArrayBuffer(size);
    const dv = new DataView(buf);
    let off = 0;

    dv.setUint32(off, PACK_MAGIC, true); off += 4;
    dv.setUint8(off, PACK_VERSION); off += 1;
    dv.setUint32(off, manifestData.length, true); off += 4;
    new Uint8Array(buf, off, manifestData.length).set(manifestData); off += manifestData.length;
    dv.setUint32(off, entries.length, true); off += 4;

    for (const [id, data] of entries) {
        const idBytes = new TextEncoder().encode(id);
        dv.setUint16(off, idBytes.length, true); off += 2;
        new Uint8Array(buf, off, idBytes.length).set(idBytes); off += idBytes.length;
        dv.setUint32(off, data.length, true); off += 4;
        new Uint8Array(buf, off, data.length).set(data); off += data.length;
    }

    return new Blob([buf], { type: 'application/octet-stream' });
}

/**
 * 从 .phantom 文件解包
 * @param {ArrayBuffer} buf
 * @returns {{ manifest: Uint8Array, chunks: Map<string, Uint8Array> }}
 */
function unpackPhantom(buf) {
    const dv = new DataView(buf);
    let off = 0;

    const magic = dv.getUint32(off, true); off += 4;
    if (magic !== PACK_MAGIC) throw new Error('无效的 .phantom 文件');
    
    const ver = dv.getUint8(off); off += 1;
    if (ver !== PACK_VERSION) throw new Error(`不支持的版本: ${ver}`);

    const mlen = dv.getUint32(off, true); off += 4;
    // ⚠️ 使用 .slice() 创建副本，避免视图指向原始 ArrayBuffer
    // 防止后续 secureZero 等操作意外污染数据
    const manifest = new Uint8Array(buf, off, mlen).slice(); off += mlen;

    const count = dv.getUint32(off, true); off += 4;
    const chunks = new Map();
    for (let i = 0; i < count; i++) {
        const idLen = dv.getUint16(off, true); off += 2;
        const id = new TextDecoder().decode(new Uint8Array(buf, off, idLen)); off += idLen;
        const dlen = dv.getUint32(off, true); off += 4;
        // ⚠️ 使用 .slice() 创建副本
        chunks.set(id, new Uint8Array(buf, off, dlen).slice()); off += dlen;
    }

    return { manifest, chunks };
}

/**
 * 检查是否为有效的 .phantom 文件
 */
function isPhantomPack(buf) {
    if (buf.byteLength < 8) return false;
    return new DataView(buf).getUint32(0, true) === PACK_MAGIC;
}

export { packPhantom, unpackPhantom, isPhantomPack };
