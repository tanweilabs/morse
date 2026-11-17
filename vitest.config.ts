import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // every test process gets a throw-away MORSE_HOME unless it sets one: tests never touch the real ~/.morse
    setupFiles: ['test/helpers/isolate-home.ts'],
    // test/ is the client, relay-cf/test the relay (public since ADR-092), scripts/test the
    // relay tooling (public) and the release tooling (private: not in the public export).
    include: ['test/**/*.test.ts', 'relay-cf/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // cli is command wiring; exec/doctor are thin diagnostic shells exercised
      // for real by scripts/smoke.sh — excluded from unit thresholds
      exclude: ['src/cli.ts', 'src/adapters/exec.ts', 'src/doctor.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
