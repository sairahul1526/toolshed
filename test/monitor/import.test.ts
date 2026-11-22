import { describe, expect, it } from 'vitest';
import { clearSampleData, exportData, importCsv, IMPORT_MAX, monitorsCsv, overview, sampleData } from '../../src/modules/monitor/ops';
import { listMonitors } from '../../src/modules/monitor/monitors';
import { createTestEnv } from '../helpers/d1';
import { ctxOf, useModule } from './helpers';

useModule();

describe('import and export', () => {
  it('imports an UptimeRobot-style file, mapping seconds to our intervals and skipping unsupported types', async () => {
    const t = createTestEnv();
    const ctx = await ctxOf(t);
    const csv = [
      'Friendly Name,URL,Type,Interval,Keyword',
      'Home,https://example.com/,HTTP(s),300,',
      'Docs,https://example.com/docs,Keyword,60,Welcome',
      'Ping box,192.0.2.5,Ping,300,',
      'Local,http://localhost/,HTTP(s),300,',
    ].join('\n');
    const report = await importCsv(ctx, csv, 1_700_000_000_000);
    expect(report.created).toBe(2);
    expect(report.skipped.map((s) => s.name)).toEqual(['Ping box', 'Local']);
    const list = await listMonitors(ctx);
    expect(list.find((m) => m.name === 'Home')?.interval_min).toBe(5);
    expect(list.find((m) => m.name === 'Docs')).toMatchObject({ interval_min: 1, keyword: 'Welcome', keyword_mode: 'present' });
  });

  it('stops at the per-request limit and says how many are left', async () => {
    const t = createTestEnv();
    const ctx = await ctxOf(t);
    const rows = Array.from({ length: IMPORT_MAX + 3 }, (_, i) => `Site ${i},https://example.com/${i}`);
    const report = await importCsv(ctx, ['name,url', ...rows].join('\n'));
    expect(report.created).toBe(IMPORT_MAX);
    expect(report.remaining).toBe(3);
  });

  it('asks for a header row with an address column', async () => {
    const t = createTestEnv();
    const ctx = await ctxOf(t);
    await expect(importCsv(ctx, 'a,b\n1,2')).rejects.toMatchObject({ code: 'monitor.import_empty' });
  });

  it('exports without secrets and round-trips the monitors file', async () => {
    const t = createTestEnv();
    const ctx = await ctxOf(t);
    await importCsv(ctx, 'name,url\nHome,https://example.com/');
    const { createChannel } = await import('../../src/modules/monitor/channels');
    await createChannel(ctx, { name: 'Hook', kind: 'webhook', config: { url: 'https://hooks.example.com/x', secret: 'topsecret' } });
    const data = JSON.stringify(await exportData(ctx));
    expect(data).not.toContain('topsecret');
    expect(await monitorsCsv(ctx)).toContain('https://example.com/');
  });

  it('fills a workspace with sample data and clears only the samples', async () => {
    const t = createTestEnv();
    const ctx = await ctxOf(t);
    await importCsv(ctx, 'name,url\nReal,https://example.com/');
    await sampleData(ctx);
    expect((await listMonitors(ctx)).length).toBeGreaterThan(1);
    expect((await overview(ctx)).length).toBeGreaterThan(0);
    await clearSampleData(ctx);
    const left = await listMonitors(ctx);
    expect(left.map((m) => m.name)).toEqual(['Real']);
    expect(await ctx.db.count('mon_pages')).toBe(0);
  });
});
