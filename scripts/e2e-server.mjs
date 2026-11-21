// Starts a fresh local app for the end-to-end tests: empty database, migrations applied, dev mode on.
// PORT picks the port (default 8787). Each port keeps its own data folder, so runs do not collide.
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT ?? '8787';
const persist = join('.wrangler', `e2e-${port}`);
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: process.env.CI ?? 'true' };

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

rmSync(join(root, persist), { recursive: true, force: true });
run('node', ['scripts/prepare.mjs']);
run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist]);

const child = spawn(
  'npx',
  [
    'wrangler', 'dev',
    '--port', port,
    '--ip', '127.0.0.1',
    '--inspector-port', String(Number(port) + 1000),
    '--persist-to', persist,
    '--var', 'ENVIRONMENT:dev',
    '--var', 'AUTH_SECRET:dev-only-secret-never-use-in-production-0123456789',
    '--var', 'OWNER_EMAIL:owner@example.com',
    '--var', `APP_URL:http://127.0.0.1:${port}`,
  ],
  { cwd: root, stdio: 'inherit', env },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
