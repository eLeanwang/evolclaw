// ── 密码学提供者（浏览器 SubtleCrypto 实现）──────────────
// 所有操作均为异步（SubtleCrypto API 要求）

/** Base64 编码（浏览器兼容） */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Base64 解码（浏览器兼容） */
function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 将 ArrayBuffer 转为 PEM 格式字符串 */
function arrayBufferToPem(buffer: ArrayBuffer, label: string): string {
  const b64 = uint8ToBase64(new Uint8Array(buffer));
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

/** 从 PEM 字符串中提取 DER 数据 */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s/g, '');
  const bytes = base64ToUint8(b64);
  return bytes.buffer;
}

/** 密码学提供者 — 使用浏览器 SubtleCrypto 实现 P-256 ECDSA */
export class CryptoProvider {
  static readonly curveName = 'P-256';

  /**
   * 生成 P-256 ECDSA 密钥对（异步）。
   * 返回 { private_key_pem, public_key_der_b64, curve }
   */
  async generateIdentity(): Promise<{
    private_key_pem: string;
    public_key_der_b64: string;
    curve: string;
  }> {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true, // extractable
      ['sign', 'verify'],
    );

    // 导出 PKCS8 私钥
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const privateKeyPem = arrayBufferToPem(pkcs8, 'PRIVATE KEY');

    // 导出 SPKI 公钥（DER 格式，base64 编码）
    const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const publicKeyDerB64 = uint8ToBase64(new Uint8Array(spki));

    return {
      private_key_pem: privateKeyPem,
      public_key_der_b64: publicKeyDerB64,
      curve: CryptoProvider.curveName,
    };
  }

  /**
   * 签名登录 nonce（异步）。
   * 返回 [signatureBase64, clientTime]
   *
   * 签名数据格式: "{nonce}:{clientTime}"
   * 使用 ECDSA + SHA-256
   */
  async signLoginNonce(
    privateKeyPem: string,
    nonce: string,
    clientTime?: string,
  ): Promise<[string, string]> {
    const usedTime = clientTime ?? String(Date.now() / 1000);
    const signData = new TextEncoder().encode(`${nonce}:${usedTime}`);

    // 导入 PEM 私钥
    const pkcs8 = pemToArrayBuffer(privateKeyPem);
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );

    // 签名（SubtleCrypto 返回 IEEE P1363 格式，与 Python cryptography DER 不同）
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      signData,
    );

    // 将 P1363 格式转为 DER 格式（与 Python SDK 兼容）
    const derSignature = p1363ToDer(new Uint8Array(signature));
    return [uint8ToBase64(derSignature), usedTime];
  }

  /** 生成客户端 nonce（12 字节随机数的 base64 编码） */
  newClientNonce(): string {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return uint8ToBase64(bytes);
  }
}

// ── 签名格式转换工具 ──────────────────────────────────────

/**
 * 将 IEEE P1363 格式签名转为 DER 格式。
 * SubtleCrypto 输出 P1363（r || s 固定长度拼接），
 * Python cryptography 使用 DER（ASN.1 编码）。
 */
function p1363ToDer(p1363: Uint8Array): Uint8Array {
  const halfLen = p1363.length / 2;
  const r = trimLeadingZeros(p1363.slice(0, halfLen));
  const s = trimLeadingZeros(p1363.slice(halfLen));

  // 若最高位为 1 需要前导 0x00（ASN.1 有符号整数）
  const rPadded = r[0] & 0x80 ? new Uint8Array([0, ...r]) : r;
  const sPadded = s[0] & 0x80 ? new Uint8Array([0, ...s]) : s;

  const rTlv = new Uint8Array([0x02, rPadded.length, ...rPadded]);
  const sTlv = new Uint8Array([0x02, sPadded.length, ...sPadded]);

  const sequenceLen = rTlv.length + sTlv.length;
  const der = new Uint8Array(2 + sequenceLen);
  der[0] = 0x30; // SEQUENCE
  der[1] = sequenceLen;
  der.set(rTlv, 2);
  der.set(sTlv, 2 + rTlv.length);
  return der;
}

/** 去除前导零字节（保留至少一个字节） */
function trimLeadingZeros(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start++;
  }
  return bytes.slice(start);
}

// 导出工具函数，供其他模块使用
export { uint8ToBase64, base64ToUint8, arrayBufferToPem, pemToArrayBuffer, p1363ToDer };
