import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createSelfSignedIdentity,
  derInteger,
  deviceIdFromCert,
  formatDeviceId,
  loadOrCreateIdentity,
  normalizeDeviceId,
  shortDeviceId,
} from '../src/cluster/identity.js';

const scratch: string[] = [];
const newHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'morse-ident-'));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** Split DER into its top-level elements: [tag, content] pairs. */
function children(der: Buffer): Array<[number, Buffer]> {
  const out: Array<[number, Buffer]> = [];
  let at = 0;
  while (at < der.length) {
    const tag = der[at]!;
    let len = der[at + 1]!;
    let head = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = der.subarray(at + 2, at + 2 + n).reduce((acc, b) => acc * 256 + b, 0);
      head += n;
    }
    out.push([tag, der.subarray(at + head, at + head + len)]);
    at += head + len;
  }
  return out;
}

describe('the certificate a new identity gets', () => {
  const { certPem, keyPem } = createSelfSignedIdentity(new Date(Date.UTC(2026, 4, 20, 8, 30, 0)));
  const cert = new X509Certificate(certPem);

  it('is a self-signed Ed25519 X.509 certificate that verifies against its own key', () => {
    expect(cert.publicKey.asymmetricKeyType).toBe('ed25519');
    expect(cert.checkPrivateKey(createPrivateKey(keyPem))).toBe(true);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.subject).toBe('CN=anytoany');
    expect(cert.issuer).toBe('CN=anytoany');
  });

  it('is valid from one day before it was made and never expires', () => {
    expect(new Date(cert.validFrom).toISOString()).toBe('2026-05-19T08:30:00.000Z');
    expect(cert.validTo).toMatch(/9999/);
  });

  it('has the fixed v3 layout: version, 16-byte serial, Ed25519, name, validity, name, key — no extensions', () => {
    const [[outerTag, outer]] = children(cert.raw) as [[number, Buffer]];
    expect(outerTag).toBe(0x30);
    const [tbs, alg, sig] = children(outer);
    expect(alg).toEqual([0x30, Buffer.from('06032b6570', 'hex')]);
    expect(sig![0]).toBe(0x03);
    expect(sig![1].length).toBe(65); // no unused bits + a 64-byte signature
    expect(sig![1][0]).toBe(0);
    const fields = children(tbs![1]);
    expect(fields.map(([t]) => t)).toEqual([0xa0, 0x02, 0x30, 0x30, 0x30, 0x30, 0x30]);
    expect(fields[0]![1]).toEqual(Buffer.from('020102', 'hex'));
    expect(fields[1]![1].length).toBe(16);
    expect(fields[3]![1]).toEqual(fields[5]![1]); // issuer = subject
    expect(fields[3]![1].includes(Buffer.from([0x0c, 8, ...Buffer.from('anytoany')]))).toBe(true); // UTF8String
    const [from, until] = children(fields[4]![1]);
    expect(from).toEqual([0x17, Buffer.from('260519083000Z')]);
    expect(until).toEqual([0x18, Buffer.from('99991231235959Z')]);
  });

  it('gets a fresh key and a fresh serial every time', () => {
    const one = createSelfSignedIdentity();
    const two = createSelfSignedIdentity();
    expect(one.keyPem).not.toBe(two.keyPem);
    expect(new X509Certificate(one.certPem).serialNumber).not.toBe(new X509Certificate(two.certPem).serialNumber);
  });

  it('always has a positive 16-byte serial with no padding byte (Node 20 rejects padded integers)', () => {
    for (let i = 0; i < 300; i++) {
      const serial = new X509Certificate(createSelfSignedIdentity().certPem).serialNumber;
      expect(serial).toHaveLength(32);
      expect(Number.parseInt(serial.slice(0, 2), 16)).toBeGreaterThanOrEqual(1);
      expect(Number.parseInt(serial.slice(0, 2), 16)).toBeLessThan(0x80);
    }
  });
});

describe('derInteger', () => {
  const hex = (...bytes: number[]) => derInteger(Buffer.from(bytes)).toString('hex');
  it('drops superfluous leading zeros', () => {
    expect(hex(0, 0, 0, 0x2a)).toBe('02012a');
    expect(hex(0, 0x12, 0x34)).toBe('02021234');
  });
  it('keeps (or adds) exactly one zero in front of a set top bit', () => {
    expect(hex(0xc0)).toBe('020200c0');
    expect(hex(0, 0, 0xc0, 1)).toBe('020300c001');
  });
  it('encodes zero as a single zero byte', () => {
    expect(hex(0, 0, 0)).toBe('020100');
    expect(hex(0)).toBe('020100');
  });
  it('leaves an already canonical value alone', () => {
    expect(hex(0x7f, 0xff)).toBe('02027fff');
  });
});

describe('device IDs', () => {
  it('are the base32 SHA-256 of the certificate DER, 52 characters in groups of seven', () => {
    const der = Buffer.from('any bytes stand in for a certificate here');
    const id = deviceIdFromCert(der);
    expect(id).toMatch(/^(?:[A-Z2-7]{7}-){7}[A-Z2-7]{3}$/);
    // the last character holds one bit of the digest: the top bit of its 5, so it is A or Q
    const lastBit = createHash('sha256').update(der).digest()[31]! & 1;
    expect(id.at(-1)).toBe(lastBit ? 'Q' : 'A');
  });

  it('match a known value', () => {
    expect(deviceIdFromCert(Buffer.from('hello'))).toBe('FTZE3OS-7WCRQ4J-XIHMVML-OPCTYNR-MHS4D6T-UEXTTAQ-ZWFE4LT-ASA');
  });

  it('read back from what people paste', () => {
    const id = deviceIdFromCert(Buffer.from('x'));
    expect(normalizeDeviceId(id)).toBe(id);
    expect(normalizeDeviceId(`\t${id.toLowerCase().replace(/-/g, '  ')}\n`)).toBe(id);
    expect(normalizeDeviceId(id.replace(/-/g, ''))).toBe(id);
    expect(normalizeDeviceId(`${id}A`)).toBeNull(); // too long
    expect(normalizeDeviceId(id.slice(0, -1))).toBeNull(); // too short
    expect(normalizeDeviceId(id.replace(/^./, '0'))).toBeNull(); // 0 is not in the alphabet
    expect(normalizeDeviceId('')).toBeNull();
  });

  it('format and shorten', () => {
    expect(formatDeviceId('ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe('ABCDEFG-HIJKLMN-OPQRSTU-VWXYZ');
    expect(formatDeviceId('')).toBe('');
    expect(shortDeviceId('QWERTYU-ASDFGHJ-ZXC')).toBe('QWERTYU');
  });
});

describe('loadOrCreateIdentity', () => {
  it('writes key.pem and cert.pem under <home>/.morse/identity with private modes, then keeps returning them', () => {
    const home = newHome();
    const first = loadOrCreateIdentity(home);
    const dir = join(home, '.morse', 'identity');
    expect(readFileSync(join(dir, 'key.pem'), 'utf8')).toBe(first.keyPem);
    expect(readFileSync(join(dir, 'cert.pem'), 'utf8')).toBe(first.certPem);
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, 'key.pem')).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'cert.pem')).mode & 0o777).toBe(0o644);
    }
    expect(first.id).toBe(deviceIdFromCert(new X509Certificate(first.certPem).raw));
    expect(loadOrCreateIdentity(home)).toEqual(first);
  });

  it('gives each home its own device', () => {
    const a = newHome();
    const b = newHome();
    expect(loadOrCreateIdentity(a).id).not.toBe(loadOrCreateIdentity(b).id);
    expect(existsSync(join(a, '.morse', 'identity', 'cert.pem'))).toBe(true);
  });
});
