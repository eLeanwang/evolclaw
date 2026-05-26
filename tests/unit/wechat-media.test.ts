import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { parseAesKey, encryptAesEcb, decryptAesEcb } from '../../src/channels/wechat.js';

describe('WeChat Media - AES Crypto', () => {
  describe('parseAesKey', () => {
    it('should decode raw 16-byte base64 key', () => {
      // Case 1: base64(raw 16 bytes)
      const rawKey = crypto.randomBytes(16);
      const base64Key = rawKey.toString('base64');
      const parsed = parseAesKey(base64Key);
      expect(parsed.length).toBe(16);
      expect(parsed.equals(rawKey)).toBe(true);
    });

    it('should decode base64-encoded hex string key', () => {
      // Case 2: base64(hex string) — SDK's encoding format
      const rawKey = crypto.randomBytes(16);
      const hexString = rawKey.toString('hex'); // 32 hex chars
      const base64Key = Buffer.from(hexString).toString('base64');
      const parsed = parseAesKey(base64Key);
      expect(parsed.length).toBe(16);
      expect(parsed.equals(rawKey)).toBe(true);
    });

    it('should throw on invalid key length', () => {
      const badKey = Buffer.from('tooshort').toString('base64');
      expect(() => parseAesKey(badKey)).toThrow('Invalid aes_key length');
    });

    it('should throw on 32-byte non-hex content', () => {
      // 32 bytes but not valid hex chars
      const notHex = Buffer.from('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'); // 32 chars, not hex
      const base64Key = notHex.toString('base64');
      expect(() => parseAesKey(base64Key)).toThrow('Invalid aes_key length');
    });
  });

  describe('encryptAesEcb / decryptAesEcb', () => {
    it('should roundtrip encrypt and decrypt', () => {
      const key = crypto.randomBytes(16);
      const plaintext = Buffer.from('Hello WeChat media encryption!');
      const ciphertext = encryptAesEcb(plaintext, key);

      expect(ciphertext.length).toBeGreaterThan(0);
      expect(ciphertext.equals(plaintext)).toBe(false);

      const decrypted = decryptAesEcb(ciphertext, key);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('should handle PKCS7 padding correctly', () => {
      const key = crypto.randomBytes(16);
      // Test with data that is exactly block-aligned (16 bytes)
      const aligned = Buffer.alloc(16, 'A');
      const enc = encryptAesEcb(aligned, key);
      // With PKCS7, 16-byte plaintext → 32-byte ciphertext (full padding block)
      expect(enc.length).toBe(32);
      const dec = decryptAesEcb(enc, key);
      expect(dec.equals(aligned)).toBe(true);
    });

    it('should handle empty plaintext', () => {
      const key = crypto.randomBytes(16);
      const empty = Buffer.alloc(0);
      const enc = encryptAesEcb(empty, key);
      // Empty + PKCS7 → 16 bytes (full padding block)
      expect(enc.length).toBe(16);
      const dec = decryptAesEcb(enc, key);
      expect(dec.length).toBe(0);
    });

    it('should handle binary data (images, etc.)', () => {
      const key = crypto.randomBytes(16);
      const binary = crypto.randomBytes(1024); // Simulate image bytes
      const enc = encryptAesEcb(binary, key);
      const dec = decryptAesEcb(enc, key);
      expect(dec.equals(binary)).toBe(true);
    });

    it('should fail with wrong key', () => {
      // AES-ECB has no authentication tag. Decryption with a wrong key either
      // throws (bad PKCS7 padding) or silently returns garbage — never the
      // original plaintext. We verify the latter as the stable invariant.
      const key1 = crypto.randomBytes(16);
      const key2 = crypto.randomBytes(16);
      const plaintext = Buffer.from('secret data');
      const ciphertext = encryptAesEcb(plaintext, key1);

      let wrongDecrypted: Buffer | null = null;
      try {
        wrongDecrypted = decryptAesEcb(ciphertext, key2);
      } catch {
        // bad PKCS7 padding — this is also a valid "wrong key" outcome
        return;
      }
      expect(wrongDecrypted!.equals(plaintext)).toBe(false);
    });
  });

  describe('AES key encoding convention (SDK compat)', () => {
    it('should match SDK sendmessage aes_key format', () => {
      // SDK sends: base64(hex_string_of_raw_key)
      const rawKey = crypto.randomBytes(16);
      const hexStr = rawKey.toString('hex');
      const sdkFormat = Buffer.from(hexStr).toString('base64');

      // Verify our parseAesKey can decode it back
      const decoded = parseAesKey(sdkFormat);
      expect(decoded.equals(rawKey)).toBe(true);
    });

    it('should handle image_item.aeskey hex → base64 conversion', () => {
      // image_item.aeskey is hex, needs conversion to base64 for parseAesKey
      const rawKey = crypto.randomBytes(16);
      const hexKey = rawKey.toString('hex'); // This is what image_item.aeskey contains

      // The conversion done in downloadMedia:
      const base64Key = Buffer.from(hexKey, 'hex').toString('base64');
      const decoded = parseAesKey(base64Key);
      expect(decoded.equals(rawKey)).toBe(true);
    });
  });

  describe('Ciphertext size calculation', () => {
    it('should compute correct PKCS7-padded size', () => {
      // Formula from implementation: Math.ceil((rawsize + 1) / 16) * 16
      const calc = (rawsize: number) => Math.ceil((rawsize + 1) / 16) * 16;

      expect(calc(0)).toBe(16);    // 0 bytes → 16 (full padding block)
      expect(calc(1)).toBe(16);    // 1 byte → 16
      expect(calc(15)).toBe(16);   // 15 bytes → 16
      expect(calc(16)).toBe(32);   // 16 bytes → 32 (full padding block added)
      expect(calc(31)).toBe(32);
      expect(calc(32)).toBe(48);
    });

    it('should match actual ciphertext length', () => {
      const key = crypto.randomBytes(16);
      const testSizes = [0, 1, 15, 16, 17, 31, 32, 100, 248731];

      for (const rawsize of testSizes) {
        const plaintext = Buffer.alloc(rawsize, 0x42);
        const ciphertext = encryptAesEcb(plaintext, key);
        const expectedSize = Math.ceil((rawsize + 1) / 16) * 16;
        expect(ciphertext.length).toBe(expectedSize);
      }
    });
  });
});
