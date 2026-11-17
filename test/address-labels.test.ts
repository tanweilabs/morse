import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ownAddressNames, mineFrom } from '../src/commands/known-as.js';
import { addressLabels, addressNamed, dropAddressLabel, namesInUse, namesOfHome, setAddressLabel } from '../src/identity/address-labels.js';

/**
 * ADR-088 §1 — the name of one of my addresses is a local label, given like a contact's remark and kept apart from
 * the agent name the relay directory has for it: naming writes one local file and nothing else; the directory
 * name stays a hidden way to say the same address; an address can have no name at all.
 */

const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const A = 'h5fdz4yvpvgtxx3x6rdd9ew7bx';
const B = 'qgwjcnwh7dt9eehdvj8wwgcvqx';
const C = 'qdfj9xfh9zch8zj7xmmr9qzmax';
/** A home whose relay directory names are `macmini` (the first address), `codex`, `notes`. */
const home = (): string => {
  const h = mkdtempSync(join(tmpdir(), 'morse-labels-'));
  homes.push(h);
  mkdirSync(join(h, '.morse', 'addresses'), { recursive: true });
  writeFileSync(join(h, '.morse', 'addresses', 'agents.json'), JSON.stringify({ v: 1, agents: { macmini: A, codex: B, notes: C } }));
  return h;
};
const file = (h: string) => join(h, '.morse', 'addresses', 'labels.json');

describe('address names (ADR-088 §1)', () => {
  const dir = { macmini: A, codex: B, notes: C };
  it('nothing said: the name is the directory name, as before — and nothing is written by reading', () => {
    const h = home();
    expect(addressLabels(h)).toEqual({});
    expect(namesOfHome(h)).toEqual({ byName: { macmini: A, codex: B, notes: C }, old: {}, directory: dir, addresses: [A, B, C], given: {} });
    expect(() => readFileSync(file(h))).toThrow();
  });

  it('a name is a local label; the directory name stays, as a hidden old name', () => {
    const h = home();
    expect(setAddressLabel(A, 'claude', h)).toEqual({ from: 'macmini', to: 'claude' });
    expect(JSON.parse(readFileSync(file(h), 'utf8'))).toEqual({ v: 1, labels: { [A]: 'claude' } });
    expect(namesOfHome(h)).toEqual({ byName: { claude: A, codex: B, notes: C }, old: { macmini: A }, directory: dir, addresses: [A, B, C], given: { [A]: 'claude' } });
    // agents.json — what the relay directory and the daemon go by — is untouched
    expect(JSON.parse(readFileSync(join(h, '.morse', 'addresses', 'agents.json'), 'utf8'))).toEqual({ v: 1, agents: dir });
    // named again: the old names are the directory's, not every name it ever had
    expect(setAddressLabel(A, 'main', h)).toEqual({ from: 'claude', to: 'main' });
    expect(namesOfHome(h).old).toEqual({ macmini: A });
    // back to what the directory calls it: that needs no label — none is kept, no old name is left
    expect(setAddressLabel(A, 'macmini', h)).toEqual({ from: 'main', to: 'macmini' });
    expect(JSON.parse(readFileSync(file(h), 'utf8'))).toEqual({ v: 1, labels: {} });
    expect(namesOfHome(h)).toMatchObject({ byName: { macmini: A }, old: {}, given: {} });
  });

  it('the rules a contact\'s remark has: free text (any script, capitals, spaces), found whatever the case', () => {
    const h = home();
    expect(setAddressLabel(B, '  工作 ', h)).toEqual({ from: 'codex', to: '工作' });
    expect(setAddressLabel(C, 'My Notes', h)).toEqual({ from: 'notes', to: 'My Notes' });
    const own = ownAddressNames(h);
    expect(mineFrom('工作', own)).toMatchObject({ address: B, name: '工作' });
    expect(mineFrom('my notes', own)).toMatchObject({ address: C, name: 'My Notes' });
    expect(mineFrom('NOTES', own)).toMatchObject({ address: C, name: 'My Notes' }); // (hidden: the directory name)
    expect(addressNamed(namesOfHome(h), 'MY NOTES')).toBe(C);
  });

  it('"" clears the name: the address has none (it is said by itself); the directory name stays a hidden way to say it', () => {
    const h = home();
    expect(setAddressLabel(B, '', h)).toEqual({ from: 'codex', to: null });
    expect(JSON.parse(readFileSync(file(h), 'utf8'))).toEqual({ v: 1, labels: {}, unnamed: [B] });
    expect(namesOfHome(h)).toEqual({ byName: { macmini: A, notes: C }, old: { codex: B }, directory: dir, addresses: [A, B, C], given: {} });
    const own = ownAddressNames(h);
    expect(mineFrom('codex', own)).toMatchObject({ address: B, name: `morse.im/${B}` });
    expect(mineFrom(B, own)).toMatchObject({ address: B, key: B });
    expect(setAddressLabel(B, '', h)).toEqual({ from: null, to: null });
    // named again: no longer unnamed
    expect(setAddressLabel(B, 'work', h)).toEqual({ from: null, to: 'work' });
    expect(JSON.parse(readFileSync(file(h), 'utf8'))).toEqual({ v: 1, labels: { [B]: 'work' } });
    // an address that goes away takes what was said about its name with it
    setAddressLabel(C, '', h);
    dropAddressLabel(C, h);
    dropAddressLabel(B, h);
    expect(JSON.parse(readFileSync(file(h), 'utf8'))).toEqual({ v: 1, labels: {} });
  });

  it('a name is one address\'s: not another\'s current name (any case), not its old one; not a command word, not address- or session-shaped', () => {
    const h = home();
    setAddressLabel(A, 'claude', h);
    for (const [address, name, why] of [
      [B, 'claude', 'the name "claude" is already used for another address'],
      [B, 'Claude', 'the name "Claude" is already used for another address'],
      [B, 'macmini', 'the name "macmini" is already used for another address'], // (A's old name: `--from macmini` must keep meaning A)
      [B, 'notes', 'the name "notes" is already used for another address'],
      [B, 'add', '"add" is a command word — pick another name'],
      [B, 'SET', '"SET" is a command word — pick another name'],
      [B, 'rename', '"rename" is a command word — pick another name'],
      [B, A, `the name "${A}" looks like an address (26 characters of the address alphabet) — pick another name`],
      [B, `morse.im/${A}`, `the name "morse.im/${A}" looks like an address (26 characters of the address alphabet) — pick another name`],
      [B, '@codex', 'the name "@codex" looks like a session (@… or a colon) — pick another name'],
      [B, 'a:b', 'the name "a:b" looks like a session (@… or a colon) — pick another name'],
      ['2222222222222222222222222x', 'x', '2222222222222222222222222x is not one of your addresses here — morse address lists them'],
    ] as Array<[string, string, string]>) {
      expect(() => setAddressLabel(address, name, h), `${address} ${name}`).toThrow(why);
    }
    expect(addressLabels(h)).toEqual({ [A]: 'claude' });
    // its own names are fine: the current one, and its old one
    expect(setAddressLabel(A, 'claude', h)).toEqual({ from: 'claude', to: 'claude' });
    expect(setAddressLabel(A, 'macmini', h)).toEqual({ from: 'claude', to: 'macmini' });
    // a blank name is no name: it clears, like "" (and like a contact's remark)
    expect(setAddressLabel(B, '   ', h)).toEqual({ from: 'codex', to: null });
  });

  it('nothing changes, nothing is written: the name it has (`set X --name X`, the hidden `rename pro pro`) creates no labels.json — also on a home with one address', () => {
    const h = home();
    expect(setAddressLabel(B, 'codex', h)).toEqual({ from: 'codex', to: 'codex' });
    expect(() => readFileSync(file(h))).toThrow();
    const one = mkdtempSync(join(tmpdir(), 'morse-labels-'));
    homes.push(one);
    mkdirSync(join(one, '.morse', 'addresses'), { recursive: true });
    writeFileSync(join(one, '.morse', 'addresses', 'agents.json'), JSON.stringify({ v: 1, agents: { pro: A } }));
    expect(setAddressLabel(A, 'pro', one)).toEqual({ from: 'pro', to: 'pro' });
    expect(() => readFileSync(file(one))).toThrow();
    // a name it was given: saying it again writes nothing either (the file is as it was, byte for byte)
    setAddressLabel(A, 'desk', one);
    const before = readFileSync(file(one), 'utf8');
    expect(setAddressLabel(A, 'desk', one)).toEqual({ from: 'desk', to: 'desk' });
    expect(readFileSync(file(one), 'utf8')).toBe(before);
    expect(JSON.parse(before)).toEqual({ v: 1, labels: { [A]: 'desk' } });
  });

  it('names are compared NFC-normalised: a precomposed and a decomposed "café" are ONE name — kept precomposed, found either way', () => {
    const h = home();
    const [nfc, nfd] = ['caf\u00e9', 'cafe\u0301'];
    expect(nfc).not.toBe(nfd);
    expect(setAddressLabel(B, nfd, h)).toEqual({ from: 'codex', to: nfc });
    expect(() => setAddressLabel(C, nfc, h)).toThrow(`the name "${nfc}" is already used for another address`);
    expect(() => setAddressLabel(C, nfd.toUpperCase(), h)).toThrow(/is already used for another address/);
    expect(addressNamed(namesOfHome(h), nfd)).toBe(B);
    expect(addressNamed(namesOfHome(h), nfc.toUpperCase())).toBe(B);
    expect(mineFrom(nfd, ownAddressNames(h))).toMatchObject({ address: B, name: nfc });
    expect(setAddressLabel(B, nfd, h)).toEqual({ from: nfc, to: nfc }); // (the same name: nothing changes)
  });

  it('the names that count as taken on my side: every name shown with several addresses; with one address only a name I gave it', () => {
    const h = home();
    expect(namesInUse(namesOfHome(h)).sort()).toEqual(['codex', 'macmini', 'notes']);
    const one = mkdtempSync(join(tmpdir(), 'morse-labels-'));
    homes.push(one);
    mkdirSync(join(one, '.morse', 'addresses'), { recursive: true });
    writeFileSync(join(one, '.morse', 'addresses', 'agents.json'), JSON.stringify({ v: 1, agents: { mini: A } }));
    expect(namesInUse(namesOfHome(one))).toEqual([]); // (`mini` is shown nowhere: nobody chose it)
    setAddressLabel(A, 'work', one);
    // …and the hidden names count: `--from mini` still means this address
    expect(namesInUse(namesOfHome(one)).sort()).toEqual(['mini', 'work']);
    setAddressLabel(A, '', one); // (its name cleared: the install-time name is still a way to say it)
    expect(namesInUse(namesOfHome(one))).toEqual(['mini']);
    // several addresses: the directory's name of one that is called something else, or nothing (`address-5`)
    setAddressLabel(B, 'lab', h);
    setAddressLabel(C, '', h);
    expect(namesInUse(namesOfHome(h)).sort()).toEqual(['codex', 'lab', 'macmini', 'notes']);
  });

  it('the commands go by the names — and still take the old name and the address (`--from`)', () => {
    const h = home();
    setAddressLabel(A, 'claude', h);
    const own = ownAddressNames(h);
    expect(own.byName).toEqual({ claude: A, codex: B, notes: C });
    expect(own.old).toEqual({ macmini: A });
    expect(mineFrom('claude', own)).toMatchObject({ address: A, name: 'claude' });
    expect(mineFrom('macmini', own)).toMatchObject({ address: A, name: 'claude' }); // (hidden: the old name)
    expect(mineFrom(`morse.im/${A.toUpperCase()}`, own)).toMatchObject({ address: A, name: 'claude' });
    expect(mineFrom('nosuch', own)).toEqual({ error: '"nosuch" is not one of your addresses here — morse address lists them' });
  });

  it('a damaged labels.json is said, never guessed around', () => {
    const h = home();
    for (const bad of ['{ not json', '{"v":1}', JSON.stringify({ v: 1, labels: { [A]: ' x ' } }), JSON.stringify({ v: 1, labels: {}, unnamed: ['nope'] })]) {
      writeFileSync(file(h), bad);
      expect(() => addressLabels(h), bad).toThrow(/labels\.json is damaged/);
      expect(ownAddressNames(h).error, bad).toMatch(/labels\.json is damaged/);
    }
  });
});
