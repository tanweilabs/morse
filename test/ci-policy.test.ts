import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflowPath = new URL('../.github/workflows/ci.yml', import.meta.url);
const macosWorkflowPath = new URL(
  '../.github/workflows/ci-macos.yml',
  import.meta.url,
);
const windowsWorkflowPath = new URL('../.github/workflows/ci-windows.yml', import.meta.url);

describe('GitHub Actions budget policy', () => {
  it('keeps normal CI on Linux and reserves macOS for scheduled or manual smoke', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const macosWorkflow = readFileSync(macosWorkflowPath, 'utf8');

    expect(workflow).not.toMatch(/os:\s*\[[^\]]*macos/i);
    expect(workflow).not.toContain('runs-on: macos-latest');
    expect(macosWorkflow).toContain('workflow_dispatch:');
    expect(macosWorkflow).toContain('schedule:');
    expect(macosWorkflow).toContain('runs-on: macos-latest');
  });

  it('keeps Windows out of normal CI: weekly or manual only, one job, a subset of the suite (ADR-080)', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const windowsWorkflow = readFileSync(windowsWorkflowPath, 'utf8');

    expect(workflow).not.toMatch(/windows/i);
    // triggers: on demand and on a schedule — never a push or a pull request
    expect(windowsWorkflow).toContain('workflow_dispatch:');
    expect(windowsWorkflow).toContain('schedule:');
    expect(windowsWorkflow).not.toMatch(/^\s*(push|pull_request|pull_request_target):/m);
    expect(windowsWorkflow.match(/- cron:/g)).toHaveLength(1);
    expect(windowsWorkflow).toMatch(/cron: '\d+ \d+ \* \* [0-6]'/); // once a week
    // one Windows job, no matrix, a newer run cancels the older one, a hard time limit
    expect(windowsWorkflow.match(/runs-on:/g)).toHaveLength(1);
    expect(windowsWorkflow).toContain('runs-on: windows-latest');
    expect(windowsWorkflow).not.toMatch(/matrix:/);
    expect(windowsWorkflow).toContain('cancel-in-progress: true');
    expect(windowsWorkflow).toMatch(/timeout-minutes: (\d|1\d)\n/);
    // a subset: named test files, never the whole suite
    expect(windowsWorkflow).toMatch(/npx vitest run test\/\S+\.test\.ts/);
    expect(windowsWorkflow).not.toMatch(/run: npm test\b/);
    // the budget is written down where the workflow is (CLAUDE.md rule 7)
    expect(windowsWorkflow).toMatch(/billed minutes a month/);
  });

  it('ADR-084: regular CI has one Node axis value, the minimum (22)', () => {
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).toMatch(/^\s*node: \[22\]$/m);
    expect(workflow).not.toMatch(/^\s*os:/m);
  });

  it('cancels superseded branch runs and skips documentation-only changes', () => {
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).toContain('concurrency:');
    expect(workflow).toContain('cancel-in-progress: true');
    expect(workflow.match(/paths-ignore:/g)).toHaveLength(2);
    expect(workflow).toContain("- 'docs/**'");
    expect(workflow).toContain("- '**/*.md'");
  });
});
