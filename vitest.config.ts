import { defineConfig } from 'vitest/config';

/** Where the test files are: the client, the relay (public since ADR-092), and the repo tooling under scripts/. */
const suites = ['test/**/*.test.ts', 'relay-cf/test/**/*.test.ts', 'scripts/test/**/*.test.ts'];

/**
 * Not held to the coverage bar: command wiring (cli.ts) and the thin shells that only make sense
 * against real agent CLIs on a real machine (exec.ts runs them, doctor.ts inspects them).
 */
const outsideCoverage = ['src/cli.ts', 'src/adapters/exec.ts', 'src/doctor.ts'];

export default defineConfig({
  test: {
    include: suites,
    // Runs first in every worker: points MORSE_HOME at a fresh temp dir unless the test set one,
    // so no test can read or write the real ~/.morse.
    setupFiles: ['test/helpers/isolate-home.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: outsideCoverage,
      thresholds: { lines: 80, functions: 80, branches: 80 },
    },
  },
});
