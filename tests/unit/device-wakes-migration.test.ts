import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Migration 076 (the iPhone's background wake), read as text. The replay and
 * the trigger's cases against a real Postgres are in the PR description; this
 * catches the silent drifts: the scan's own claim waking every phone, a write
 * that makes an HTTP request, and a definer function with a search_path.
 */
const FILE = readFileSync(resolve(__dirname, '../../supabase/migrations/076_device_wakes.sql'), 'utf8');
const SQL = FILE.split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')
  .toLowerCase();
const FLAT = SQL.replace(/\s+/g, ' ');

describe('076_device_wakes', () => {
  it('adds the two stamps the drain reads, idempotently', () => {
    expect(FLAT).toContain('alter table public.devices add column if not exists wake_requested_at timestamptz;');
    expect(FLAT).toContain('alter table public.devices add column if not exists last_background_push_at timestamptz;');
  });

  it('never wakes for the scan claiming a cue: reminder_sent_key is not compared', () => {
    expect(FLAT).not.toContain('reminder_sent_key');
    expect(FLAT).toContain('is not distinct from');
    for (const column of ['completed_dates', 'skipped_dates', 'daily_counts', 'paused_at', 'reminder_time', 'reminder_snooze_until']) {
      expect(FLAT).toContain(`old.${column}`);
      expect(FLAT).toContain(`new.${column}`);
    }
  });

  it('stamps apns rows only, and makes no request from inside a write', () => {
    expect(FLAT).toContain("and transport = 'apns'");
    expect(FLAT).not.toMatch(/\bnet\.|http_post|http_get|dsul_post/);
  });

  it('is a definer with an empty search_path that swallows its own errors, executable by no one', () => {
    expect(FLAT).toContain('security definer');
    expect(FLAT).toContain("set search_path = ''");
    expect(FLAT).toContain('exception when others then return null;');
    for (const role of ['public', 'anon', 'authenticated']) {
      expect(FLAT).toContain(`revoke all on function public.items_request_wake() from ${role};`);
    }
    expect(FLAT).not.toMatch(/\bgrant\b/);
  });

  it('re-creates its trigger on re-run', () => {
    expect(FLAT).toContain('drop trigger if exists items_request_wake on public.items;');
    expect(FLAT).toContain('after insert or update or delete on public.items for each row execute function public.items_request_wake();');
  });
});
