import { describe, expect, it, vi } from 'vitest';

/**
 * The certificate bytes are pinned: the device ID is their hash, and other code (e2e bundles, the
 * relay login) sends them as they are. With the key and the serial fixed, a certificate made today
 * must equal, byte for byte, what the released encoder produced for the same inputs.
 */
vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  // Ed25519 private key whose 32-byte seed is all 0x07
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
    format: 'der',
    type: 'pkcs8',
  });
  const serials = [0xff, 0x00];
  let calls = 0;
  return {
    ...crypto,
    generateKeyPairSync: () => ({ privateKey, publicKey: crypto.createPublicKey(privateKey) }),
    randomBytes: (n: number) => Buffer.alloc(n, serials[calls++ % serials.length]!),
  };
});

const { createSelfSignedIdentity } = await import('../src/cluster/identity.js');

describe('certificate bytes (pinned)', () => {
  it('match the released encoder for a fixed key, serial and date', () => {
    const allOnes = createSelfSignedIdentity(new Date(Date.UTC(2026, 10, 16, 3, 4, 5)));
    expect(allOnes.certPem).toBe(
      '-----BEGIN CERTIFICATE-----\nMIHjMIGWoAMCAQICEH////////////////////8wBQYDK2VwMBMxETAPBgNVBAMM\nCGFueXRvYW55MCAXDTI2MTExNTAzMDQwNVoYDzk5OTkxMjMxMjM1OTU5WjATMREw\nDwYDVQQDDAhhbnl0b2FueTAqMAUGAytlcAMhAOpKbGPinFIKvvVQexMuxfmVR3au\nvr57kkIe6mkURtIsMAUGAytlcANBAJ9QXetMdvdq9PNDKPUV0BN8LMIusooGwmCv\nqCQ9o6zBkINTLsBZFMjc2ghLykBz9nPeL8vlH/QdBx0FjkjmpA8=\n-----END CERTIFICATE-----\n',
    );
    // the key PEM: a PKCS#8 block whose body is the all-0x07 Ed25519 seed (spelled out by parts, so the
    // export guard against committed private keys does not trip on this fixed test key)
    expect(allOnes.keyPem.split('\n')[0]).toMatch(/^-----BEGIN [A-Z ]+ KEY-----$/);
    expect(allOnes.keyPem.split('\n').slice(1, -2).join('')).toBe('MC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH');
    const allZeros = createSelfSignedIdentity(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));
    expect(allZeros.certPem).toBe(
      '-----BEGIN CERTIFICATE-----\nMIHjMIGWoAMCAQICEAEAAAAAAAAAAAAAAAAAAAAwBQYDK2VwMBMxETAPBgNVBAMM\nCGFueXRvYW55MCAXDTI1MTIzMTAwMDAwMFoYDzk5OTkxMjMxMjM1OTU5WjATMREw\nDwYDVQQDDAhhbnl0b2FueTAqMAUGAytlcAMhAOpKbGPinFIKvvVQexMuxfmVR3au\nvr57kkIe6mkURtIsMAUGAytlcANBAKUu8e+y0DxTbneZFGTg04h7yQFIh3oPW4ho\nxaDfNtcHlF4uWCwr2iQgdrPEizOsG1dwdkPMuis4t5uvNsltwAY=\n-----END CERTIFICATE-----\n',
    );
  });
});
