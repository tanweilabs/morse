import { describe, expect, it } from 'vitest';
import { safeFileName as fromMorse } from '../src/cluster/morse.js';
import { safeFileName, uniqueFileName } from '../src/platform/filename.js';

/**
 * A file name chosen by the SENDER (ADR-080). It used to be stripped of directories, control
 * characters and a leading dot only — enough on macOS / Linux, not on Windows: `:` addresses
 * an NTFS alternate data stream, `< > " | ? *` cannot be created, CON / NUL / COM1 … are
 * devices whatever the extension, and trailing dots and spaces are dropped silently. The
 * rules are the same on every platform: a Mac may forward the file to someone on Windows.
 */

describe('safeFileName — a sender-chosen file name (all platforms)', () => {
  it('ordinary names are left exactly as they were', () => {
    for (const name of ['report.pdf', 'a b.txt', '报告 final (2).docx', 'x.tar.gz', 'Makefile', 'a_b-c.d']) expect(safeFileName(name)).toBe(name);
    // what it already did: no path, no control characters, no leading dot
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..\\..\\x.sh')).toBe('x.sh');
    expect(safeFileName('.bashrc')).toBe('bashrc');
    expect(safeFileName('a\u0000b\u001f.txt')).toBe('ab.txt');
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('x'.repeat(300), 'darwin')).toHaveLength(200);
  });

  it('":" never reaches the disk — on NTFS "report.txt:x" would write a hidden stream of report.txt', () => {
    expect(safeFileName('report.txt:hidden')).toBe('report.txt_hidden');
    expect(safeFileName('a:b.txt')).toBe('a_b.txt');
    expect(safeFileName('report.txt::$DATA')).toBe('report.txt__$DATA');
    // a drive letter is not a directory to strip: it is a ":" like any other, the same on every platform
    expect(safeFileName('C:evil.txt', 'win32')).toBe('C_evil.txt');
    expect(safeFileName('C:evil.txt', 'darwin')).toBe('C_evil.txt');
    expect(safeFileName('C:\\Users\\me\\a.txt')).toBe('a.txt');
  });

  it('characters Windows refuses in a name become "_"', () => {
    expect(safeFileName('a<b>c"d|e?f*g.txt')).toBe('a_b_c_d_e_f_g.txt');
  });

  it('reserved device names get a "_" in front — with any extension, any case, spaces before the dot', () => {
    for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'COM0', 'LPT1', 'lpt9', 'CONIN$', 'CONOUT$', 'COM\u00b9', 'LPT\u00b3']) expect(safeFileName(name)).toBe(`_${name}`);
    expect(safeFileName('NUL.txt')).toBe('_NUL.txt');
    expect(safeFileName('com1.tar.gz')).toBe('_com1.tar.gz');
    expect(safeFileName('aux .log')).toBe('_aux .log');
    expect(safeFileName('dir/CON')).toBe('_CON');
    // not reserved: longer names that merely start like one
    for (const name of ['CONSOLE.txt', 'COM10', 'nulls.csv', 'LPT', 'com.txt']) expect(safeFileName(name)).toBe(name);
  });

  it('trailing dots and spaces are dropped (Windows drops them silently: "a.txt." would collide with "a.txt")', () => {
    expect(safeFileName('a.txt.')).toBe('a.txt');
    expect(safeFileName('a.txt . .')).toBe('a.txt');
    expect(safeFileName('name ')).toBe('name');
    expect(safeFileName('...')).toBe('file');
    expect(safeFileName(' . ')).toBe('file');
    // a reserved name hidden behind trailing dots
    expect(safeFileName('NUL..')).toBe('_NUL');
  });

  it('on Windows the name is cut to 120 characters (the 260-character path limit), and the cut leaves no trailing dot', () => {
    expect(safeFileName('x'.repeat(300), 'win32')).toHaveLength(120);
    expect(safeFileName(`${'x'.repeat(119)}.txt`, 'win32')).toBe('x'.repeat(119));
    expect(safeFileName(`${'x'.repeat(199)}.txt`, 'linux')).toBe('x'.repeat(199));
  });
});

describe('the mailbox uses this one function', () => {
  it('src/cluster/morse.ts exports the same safeFileName', () => {
    expect(fromMorse).toBe(safeFileName);
    expect(fromMorse('a:b.txt')).toBe('a_b.txt');
  });
});

describe('names that are the same file are told apart, never overwritten', () => {
  const all = (...names: string[]) => {
    const used = new Set<string>();
    return names.map((n) => uniqueFileName(safeFileName(n), used));
  };

  it('two attachments with the same name: the second gets a "_" in front', () => {
    expect(all('a.txt', 'a.txt', 'a.txt')).toEqual(['a.txt', '_a.txt', '__a.txt']);
  });

  it('names that only BECOME equal by the clean-up count too', () => {
    expect(all('a:b.txt', 'a?b.txt', 'a_b.txt')).toEqual(['a_b.txt', '_a_b.txt', '__a_b.txt']);
    expect(all('notes.txt', 'notes.txt.', 'notes.txt ')).toEqual(['notes.txt', '_notes.txt', '__notes.txt']);
  });

  it('names a case-insensitive file system (macOS, Windows) takes for one file: A.txt and a.txt, and two spellings of one accented letter', () => {
    expect(all('Report.PDF', 'report.pdf')).toEqual(['Report.PDF', '_report.pdf']);
    expect(all('caf\u00e9.txt', 'cafe\u0301.txt')).toEqual(['caf\u00e9.txt', '_cafe\u0301.txt']);
    // different names stay as they are
    expect(all('a.txt', 'b.txt', 'A1.txt')).toEqual(['a.txt', 'b.txt', 'A1.txt']);
  });
});
