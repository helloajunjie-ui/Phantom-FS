'use strict';

/**
 * Phantom-FS / V12.1 QR Code 编码/解码模块
 * ===========================================
 * 将二进制 .ptm Manifest 编码为高密度二维码
 * 支持实体冷钱包：打印纸质版放进保险箱
 * 
 * QR Code 内容格式：
 *   PTM:{Base64编码的二进制 Manifest}
 *   前缀 "PTM:" 用于解码时自动识别格式
 * 
 * @module qr-code
 */

import { exportBinaryManifest, importBinaryManifest, binaryManifestToBase64, base64ToArrayBuffer } from '../core/manifest.js';

/** @constant {string} QR Code 内容前缀 */
const QR_PREFIX = 'PTM:';

/**
 * QR Code 编码器
 * 
 * @class QRCodeEncoder
 */
class QRCodeEncoder {
    /**
     * @param {Object} [options]
     * @param {number} [options.size=512] - 二维码图片尺寸（像素）
     */
    constructor(options = {}) {
        this._size = options.size || 512;
    }

    /**
     * 将 Manifest 编码为 QR Code Data URL
     * 
     * 编码流程：
     *   Manifest Object → 二进制 .ptm → Base64 → QR Code
     * 
     * @param {Object|string} manifest - Manifest 对象或 JSON 字符串
     * @returns {Promise<string>} QR Code 图片的 Data URL (image/png)
     */
    async encode(manifest) {
        // 统一转为对象
        const obj = typeof manifest === 'string' ? JSON.parse(manifest) : manifest;
        
        // 序列化为二进制 .ptm
        const ptmBuffer = exportBinaryManifest(obj);
        
        // Base64 编码 + 添加前缀
        const base64 = binaryManifestToBase64(ptmBuffer);
        const qrContent = QR_PREFIX + base64;

        // 使用 QRCode.js 库生成二维码
        if (typeof QRCode !== 'undefined') {
            return await this._encodeWithQRCode(qrContent);
        }

        throw new Error('QRCode 库不可用');
    }

    /**
     * 使用 QRCode 库的 toCanvas API
     * @private
     */
    async _encodeWithQRCode(text) {
        const canvas = document.createElement('canvas');

        try {
            await QRCode.toCanvas(canvas, text, {
                width: this._size,
                margin: 2,
                errorCorrectionLevel: 'M',
                color: {
                    dark: '#000000',
                    light: '#ffffff'
                }
            });
        } catch (err) {
            // 回调风格兼容
            return await new Promise((resolve, reject) => {
                QRCode.toCanvas(canvas, text, {
                    width: this._size,
                    margin: 2,
                    errorCorrectionLevel: 'M'
                }, (error) => {
                    if (error) return reject(error);
                    resolve(canvas.toDataURL('image/png'));
                });
            });
        }

        return canvas.toDataURL('image/png');
    }

    /**
     * 从 QR Code 图片解析 Manifest
     * 
     * 解码流程：
     *   QR Code → Base64 → 二进制 .ptm → Manifest Object
     * 
     * @param {string|HTMLImageElement|File} imageData - 图片数据
     * @returns {Promise<Object>} 解析后的 Manifest
     */
    async decode(imageData) {
        if (typeof jsQR === 'undefined') {
            throw new Error('QR Code 解码需要 jsQR 库');
        }

        const imageDataObj = await this._getImageData(imageData);
        const code = jsQR(imageDataObj.data, imageDataObj.width, imageDataObj.height);

        if (!code) {
            throw new Error('未检测到 QR Code');
        }

        const text = code.data;

        // 检测 Phantom-FS 二进制格式
        if (text.startsWith(QR_PREFIX)) {
            const base64 = text.slice(QR_PREFIX.length);
            const buffer = base64ToArrayBuffer(base64);
            return importBinaryManifest(buffer);
        }

        // 兼容旧版 JSON 格式
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error('QR Code 内容格式无效');
        }
    }

    /**
     * @private
     */
    async _getImageData(imageData) {
        if (imageData instanceof HTMLImageElement) {
            return this._imageToData(imageData);
        }
        if (imageData instanceof File) {
            const img = await this._fileToImage(imageData);
            return this._imageToData(img);
        }
        if (typeof imageData === 'string') {
            const img = await this._urlToImage(imageData);
            return this._imageToData(img);
        }
        throw new Error('不支持的图片格式');
    }

    /**
     * @private
     */
    _imageToData(img) {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    /**
     * @private
     */
    _fileToImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = reader.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    /**
     * @private
     */
    _urlToImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = url;
        });
    }
}

export { QRCodeEncoder };
