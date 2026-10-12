import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('repository consistency', () => {
  it('every `npm run <script>` used by a workflow exists in the root package.json', () => {
    const scripts = Object.keys(JSON.parse(read('package.json')).scripts as Record<string, string>);
    const used = new Set<string>();
    for (const f of readdirSync(join(root, '.github/workflows'))) {
      for (const m of read(`.github/workflows/${f}`).matchAll(/npm run ([A-Za-z0-9:_-]+)(?!.*\s-w\s)/g)) {
        // Workspace-scoped invocations (-w ...) are checked by npm itself; only root scripts matter here.
        const line = read(`.github/workflows/${f}`).split('\n').find((l) => l.includes(m[0]))!;
        if (!/\s(-w|--workspace)\b/.test(line)) used.add(m[1]!);
      }
    }
    expect(used.size).toBeGreaterThan(3);
    for (const name of used) expect(scripts).toContain(name);
  });

  it('every root script that delegates to a workspace points at a script that exists there', () => {
    const rootScripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    for (const [name, cmd] of Object.entries(rootScripts)) {
      const m = cmd.match(/^npm run ([\w:.-]+) -w (\S+)$/);
      if (!m) continue;
      const dir = m[2] === 'infra' ? 'infra' : m[2]!.replace('@s3up/', 'apps/');
      const target = JSON.parse(read(`${dir}/package.json`)).scripts as Record<string, string>;
      expect({ name, exists: m[1]! in target }).toEqual({ name, exists: true });
    }
  });

  it('uses the same pinned LocalStack image in docker-compose, CI and the README', () => {
    const tag = (text: string) => [...text.matchAll(/localstack\/localstack:([0-9][\w.]*)/g)].map((m) => m[1]);
    const compose = new Set(tag(read('docker-compose.yml')));
    const ci = new Set(tag(read('.github/workflows/ci.yml')));
    const readme = new Set(tag(read('README.md')));
    expect(compose.size).toBe(1);
    expect([...ci]).toEqual([...compose]);
    expect([...readme]).toEqual([...compose]);
  });

  it('keeps the deploy workflow manual-only and gated behind an explicit repository variable', () => {
    const deploy = read('.github/workflows/deploy.yml');
    expect(deploy).toMatch(/^on:\s*\n\s+workflow_dispatch:/m);
    expect(deploy).not.toMatch(/^\s+(push|pull_request|schedule):/m);
    expect(deploy).toContain("vars.ENABLE_AWS_DEPLOY == 'true'");
    expect(deploy).toMatch(/id-token:\s*write/);
    expect(deploy).not.toMatch(/AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)/);
  });
});
