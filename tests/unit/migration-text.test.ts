import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every migration from 058 on, read as text, against the rules
 * memory/plans/reminders-platforms.md §5.8 puts on new SQL.
 *
 * Each rule is one a database replay cannot see. CI's E2E job replays the tree
 * onto a Supabase stack, and a function with an open search_path, a reminder
 * window written as `time + interval`, a grant that a later revoke strips, or a
 * column grant that hands a push token to its owner all apply there without a
 * murmur. They fail later, quietly, in production:
 *
 *   1. `set search_path = ''` on every new function (057's rule, 050 before it).
 *      A SECURITY DEFINER function resolving names through a caller's path is
 *      the classic hijack; an empty path makes every unqualified name an error
 *      at the first call instead.
 *   2. No `time + interval` (design decision 22). Postgres `time` arithmetic
 *      wraps modulo 24 hours: `time '23:50' + interval '30 minutes'` is
 *      00:20:00, and `least(…, time '23:59:59')` does not clamp it, so a window
 *      written that way is silently CLOSED from 23:30 to midnight. Windows are
 *      decided in lib/reminders/due.ts, in minutes of day, clamped.
 *   3. Revoke before grant (053's order). Supabase's default privileges grant
 *      anon and authenticated ALL on every new table and function; a grant
 *      that precedes the revoke is undone by it, and a column grant is undone
 *      by `revoke all` too.
 *   4. `authenticated` never reads `token` or `keys` (design decision 21). A
 *      web-push endpoint plus its keys is a bearer capability to push; the
 *      owner reads a column list that excludes both.
 *   5. Every `cron.*` call sits behind a `to_regclass('cron.job')` guard in a
 *      `do` block: after 058's early exit, or inside an `is not null` branch.
 *      CI's stack has real pg_cron, so an unguarded call passes there
 *      (013/035/044 call it unguarded and pass every day); only
 *      scripts/verify-058.sh's bare replay finds one, and that runs by hand
 *      and replays 058 alone. For 059 on, this is the only check.
 *
 * SCOPED FROM 058. Older migrations are applied and never edited, and several
 * predate a rule (035/044's `public, vault, net` path, 012's bare service_role
 * grant), so a rule applied to them would fail on history nobody may change.
 *
 * TEXT, NOT A DATABASE. It sees no types (a `time` COLUMN plus an interval
 * looks like any other sum) and parses nothing; it catches the spellings the
 * plan names. The replay is scripts/verify-058.sh.
 */

const DIR = join(process.cwd(), 'supabase/migrations');
const FIRST_RULED = 58;

const ALL = readdirSync(DIR)
  .filter((name) => /^\d{3}_.+\.sql$/.test(name))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }));

const RULED = ALL.filter(({ name }) => Number(name.slice(0, 3)) >= FIRST_RULED);

/**
 * The SQL without its comments, lower-cased. The headers DISCUSS the very
 * spellings refused below (058's own header quotes `time + interval`), so a
 * rule that read comments would fail the file that explains it.
 */
function code(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .toLowerCase();
}

/** Rule 1: every function head sets an empty path, and no path is ever set to anything else. */
function searchPathViolations(sql: string): string[] {
  const out: string[] = [];
  const src = code(sql);
  for (const match of src.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w."]+)/g)) {
    const rest = src.slice(match.index);
    const bodyAt = rest.search(/\bas\s+\$[a-z_]*\$/);
    const head = bodyAt < 0 ? rest : rest.slice(0, bodyAt);
    if (!/\bset\s+search_path\s*(?:=|to)\s*''/.test(head)) {
      out.push(`${match[1]}: no set search_path = ''`);
    }
  }
  for (const match of src.matchAll(
    /\bset\s+(?:local\s+)?search_path\s*(?:=|to)\s*('[^']*'|"[^"]*"|[\w$"]+(?:\s*,\s*[\w$"]+)*)/g
  )) {
    if (match[1] !== "''") out.push(`search_path set to ${match[1]}`);
  }
  return out;
}

/** Rule 2: time-of-day plus or minus an interval, in the spellings that wrap. */
function timeArithmeticViolations(sql: string): string[] {
  const TIME =
    String.raw`(?:\btime(?:tz)?\s+'[^']*'|\btime\s+with(?:out)?\s+time\s+zone\s+'[^']*'|` +
    String.raw`::\s*time(?:tz)?\b|::\s*time\s+with(?:out)?\s+time\s+zone\b|\bas\s+time(?:tz)?\s*\))`;
  const INTERVAL = String.raw`(?:\binterval\b|'[^']*'\s*::\s*interval\b|\bmake_interval\s*\()`;
  const re = new RegExp(`${TIME}\\s*[-+]\\s*${INTERVAL}`, 'g');
  return [...code(sql).matchAll(re)].map((m) => m[0].replace(/\s+/g, ' '));
}

interface Privilege {
  kind: 'grant' | 'revoke';
  at: number;
  privileges: string;
  object: string;
  grantees: string[];
}

/** The object a GRANT/REVOKE names, without schema or argument list, so `public.x(text)` and `x` agree. */
function objectName(raw: string): string {
  return raw.replace(/"/g, '').replace(/^public\./, '');
}

/**
 * Every GRANT and REVOKE … ON … statement, in file order. Role grants
 * (`grant x to y`, no ON) and `alter default privileges` are not object
 * privileges and are skipped.
 */
function privilegeStatements(sql: string): Privilege[] {
  const src = code(sql);
  const out: Privilege[] = [];
  const re =
    /\b(grant|revoke)\s+([^;]*?)\s+on\s+(?:(?:table|function|sequence|procedure)\s+)?([\w."]+)[^;]*?\b(to|from)\s+([^;]*)/g;
  for (const match of src.matchAll(re)) {
    if (/alter\s+default\s+privileges[^;]*$/.test(src.slice(0, match.index))) continue;
    out.push({
      kind: match[1] as 'grant' | 'revoke',
      at: match.index,
      privileges: match[2].replace(/\s+/g, ' ').trim(),
      object: objectName(match[3]),
      grantees: match[5].split(',').map((g) => g.trim().replace(/\s.*$/, '')),
    });
  }
  return out;
}

/** Rule 3: a grant on an object no earlier statement in the file revoked. */
function grantBeforeRevokeViolations(sql: string): string[] {
  const stmts = privilegeStatements(sql);
  return stmts
    .filter((s) => s.kind === 'grant')
    .filter((g) => !stmts.some((r) => r.kind === 'revoke' && r.object === g.object && r.at < g.at))
    .map((g) => `grant ${g.privileges} on ${g.object} with no revoke before it`);
}

const SECRET_COLUMNS = ['token', 'keys'];

/** Tables, anywhere in the tree, that hold a `token` or `keys` column. */
function tablesWithSecretColumns(files: readonly { text: string }[]): Set<string> {
  const tables = new Set<string>();
  for (const { text } of files) {
    const src = code(text);
    for (const match of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(/g)) {
      // The column list, up to the paren that closes it.
      let depth = 1;
      let i = match.index + match[0].length;
      const start = i;
      while (i < src.length && depth > 0) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') depth--;
        i++;
      }
      const cols = src.slice(start, i - 1);
      if (new RegExp(String.raw`(?:^|,)\s*(?:${SECRET_COLUMNS.join('|')})\s+\w`, 'm').test(cols)) {
        tables.add(objectName(match[1]));
      }
    }
    for (const match of src.matchAll(
      new RegExp(
        String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)[^;]*?\badd\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?(?:${SECRET_COLUMNS.join('|')})\s`,
        'g'
      )
    )) {
      tables.add(objectName(match[1]));
    }
  }
  return tables;
}

/**
 * Rule 4: `authenticated` (or anyone below it) handed a token. Two shapes: a
 * column list that names one, or a whole-table read of a table that has one.
 */
function secretColumnGrantViolations(sql: string, secretTables: Set<string>): string[] {
  const out: string[] = [];
  for (const s of privilegeStatements(sql)) {
    if (s.kind !== 'grant') continue;
    if (!s.grantees.some((g) => ['authenticated', 'anon', 'public'].includes(g))) continue;
    const columns = [...s.privileges.matchAll(/\(([^)]*)\)/g)].flatMap((m) =>
      m[1].split(',').map((c) => c.trim().replace(/"/g, ''))
    );
    const named = columns.filter((c) => SECRET_COLUMNS.includes(c));
    if (named.length) out.push(`${s.object}: ${named.join(', ')} granted to ${s.grantees.join(', ')}`);
    // A privilege with no column list of its own covers every column.
    const wholeTable = s.privileges
      .replace(/\([^)]*\)/g, '(cols)')
      .split(',')
      .map((p) => p.trim())
      .some((p) => /^(all|all privileges|select|insert|update)$/.test(p));
    if (wholeTable && secretTables.has(s.object)) {
      out.push(`${s.object}: whole-table ${s.privileges} reaches ${SECRET_COLUMNS.join('/')}`);
    }
  }
  return out;
}

/** A `cron.*` name, never the quoted 'cron.job' a guard names. */
const CRON_REF = /(?<!')\bcron\.[a-z_]+/g;

/** `to_regclass('cron.job') is ` — a guard's condition, up to its null test. */
const CRON_GUARD = String.raw`to_regclass\s*\(\s*'cron\.job'\s*\)\s+is\s+`;

/** The early exit, from just after its `if`: `if to_regclass('cron.job') is null then return; end if`. */
const EARLY_EXIT = new RegExp(String.raw`^\s*${CRON_GUARD}null\s+then\s+return\s*;\s*end\s+if\b`);

/** The guarded branch, from just after its `if`: `if to_regclass('cron.job') is not null then`. */
const GUARDED_BRANCH = new RegExp(String.raw`^\s*${CRON_GUARD}not\s+null\s+then\b`);

/**
 * What a `do` block's body opens and closes, in order: an IF statement (an
 * `if` that starts a statement, which `drop … if exists` never does), its
 * `end if`, a statement-level `else`/`elsif`, a loop and its `end loop`, and
 * every cron reference.
 */
const BLOCK_TOKEN =
  /(?<=(?:^|;|\bbegin|\bthen|\belse|\bloop)\s*)if\b|\bend\s+if\b|(?<=;\s*)(?:elsif|else)\b|\bend\s+loop\b|\bloop\b|(?<!')\bcron\.[a-z_]+/g;

/**
 * The cron references in one `do` block's body that a bare Postgres would
 * reach. A reference is guarded only in one of two shapes:
 *
 *   · after 058's early exit, `if to_regclass('cron.job') is null then
 *     return; end if;`, taken at the block's top level (inside another IF or a
 *     loop it might never run);
 *   · inside the THEN branch of `if to_regclass('cron.job') is not null then
 *     … end if` (an `else` there is the branch with NO pg_cron).
 *
 * Mentioning the guard somewhere in the block is not enough. Guarding only
 * the unschedule, because it raises on a job that is missing, and then
 * scheduling bare is the realistic slip, and a stack with pg_cron passes it.
 */
function unguardedInBlock(body: string): string[] {
  const out: string[] = [];
  const ifs: { guarded: boolean }[] = [];
  let loops = 0;
  let exited = false;
  for (const match of body.matchAll(BLOCK_TOKEN)) {
    const token = match[0];
    if (token === 'if') {
      const rest = body.slice(match.index + token.length);
      if (ifs.length === 0 && loops === 0 && EARLY_EXIT.test(rest)) exited = true;
      ifs.push({ guarded: GUARDED_BRANCH.test(rest) });
    } else if (/^end\s+if$/.test(token)) {
      ifs.pop();
    } else if (token === 'else' || token === 'elsif') {
      if (ifs.length > 0) ifs[ifs.length - 1].guarded = false;
    } else if (/^end\s+loop$/.test(token)) {
      loops = Math.max(0, loops - 1);
    } else if (token === 'loop') {
      loops += 1;
    } else if (!exited && !ifs.some((frame) => frame.guarded)) {
      out.push(token);
    }
  }
  return out;
}

/** Rule 5: a `cron.*` reference outside a guard on to_regclass('cron.job') in a `do` block. */
function unguardedCronViolations(sql: string): string[] {
  const src = code(sql);
  const blocks = [...src.matchAll(/\bdo\s+(\$[a-z_]*\$)([\s\S]*?)\1/g)];
  const out: string[] = [];
  // Outside every do block: a top-level statement, which nothing can guard.
  for (const ref of src.matchAll(CRON_REF)) {
    if (!blocks.some((block) => ref.index > block.index && ref.index < block.index + block[0].length)) {
      out.push(ref[0]);
    }
  }
  for (const block of blocks) out.push(...unguardedInBlock(block[2]));
  if (/create\s+extension\s+(?:if\s+not\s+exists\s+)?pg_cron/.test(src)) {
    out.push('create extension pg_cron (013/035 own it; a bare Postgres has none)');
  }
  return out;
}

describe(`migrations from ${String(FIRST_RULED).padStart(3, '0')} on`, () => {
  it('there is at least one file under the rules (the scope is not silently empty)', () => {
    expect(RULED.map((f) => f.name)).toContain('058_resume_cron_tick.sql');
  });

  const secretTables = tablesWithSecretColumns(ALL);

  describe.each(RULED.map((f) => [f.name, f.text] as const))('%s', (_name, text) => {
    it("sets search_path = '' on every function, and never anything else", () => {
      expect(searchPathViolations(text)).toEqual([]);
    });

    it('writes no time + interval arithmetic (decision 22: it wraps at midnight)', () => {
      expect(timeArithmeticViolations(text)).toEqual([]);
    });

    it('revokes before it grants', () => {
      expect(grantBeforeRevokeViolations(text)).toEqual([]);
    });

    it('never lets authenticated read a token or keys column', () => {
      expect(secretColumnGrantViolations(text, secretTables)).toEqual([]);
    });

    it("guards every cron.* call with to_regclass('cron.job')", () => {
      expect(unguardedCronViolations(text)).toEqual([]);
    });
  });
});

describe('the rules bite', () => {
  // Each rule against the spelling it exists for, so a regex that stopped
  // matching anything cannot pass every file by accident.

  it("search_path: a function with an open path, or none, is refused; '' passes", () => {
    expect(
      searchPathViolations(`create or replace function public.f() returns void language sql
        security definer set search_path = public, vault, net as $$ select 1 $$;`)
    ).toHaveLength(2);
    expect(
      searchPathViolations(`create function public.g() returns void language sql as $$ select 1 $$;`)
    ).toEqual(["public.g: no set search_path = ''"]);
    expect(
      searchPathViolations(`create function public.h() returns void language sql
        set search_path = '' as $fn$ select 1 $fn$;`)
    ).toEqual([]);
    // Talking about it in a comment is not doing it.
    expect(searchPathViolations(`-- 035 set search_path = public, vault, net`)).toEqual([]);
  });

  it('time + interval: the 23:30 trap in its usual spellings', () => {
    expect(timeArithmeticViolations(`select time '23:50' + interval '30 minutes'`)).toHaveLength(1);
    expect(
      timeArithmeticViolations(
        `select least(reminder_time::time + interval '30 minutes', time '23:59:59')`
      )
    ).toHaveLength(1);
    expect(timeArithmeticViolations(`select t::time - '5 min'::interval`)).toHaveLength(1);
    expect(timeArithmeticViolations(`select cast(t as time) + make_interval(mins => 30)`)).toHaveLength(1);
    // Instants are fine: a timestamptz does not wrap.
    expect(timeArithmeticViolations(`select now() + interval '30 minutes'`)).toEqual([]);
    expect(timeArithmeticViolations(`select x::timestamptz + interval '1 day'`)).toEqual([]);
  });

  it('revoke before grant: the grant first is refused, the revoke first passes', () => {
    expect(
      grantBeforeRevokeViolations(`grant select on public.t to authenticated;
        revoke all on public.t from public, anon, authenticated;`)
    ).toHaveLength(1);
    expect(
      grantBeforeRevokeViolations(`revoke all on table public.t from public, anon, authenticated;
        grant select (id, prefs) on public.t to authenticated;
        grant all on table t to service_role;
        revoke all on function public.f(text, boolean) from public, anon, authenticated;
        grant execute on function public.f(text, boolean) to service_role;`)
    ).toEqual([]);
  });

  it('token / keys: a column list naming one, or a whole-table read of a table with one', () => {
    const tables = tablesWithSecretColumns([
      {
        text: `create table if not exists public.devices (
          id uuid primary key, user_id uuid not null, token text, keys jsonb,
          prefs jsonb not null default '{}'::jsonb, check (char_length(token) < 4096));`,
      },
    ]);
    expect([...tables]).toEqual(['devices']);
    expect(
      secretColumnGrantViolations(
        `grant select (id, token, prefs) on public.devices to authenticated;`,
        tables
      )
    ).toHaveLength(1);
    expect(
      secretColumnGrantViolations(`grant select on table public.devices to authenticated;`, tables)
    ).toHaveLength(1);
    expect(
      secretColumnGrantViolations(
        `grant select (id, user_id, prefs) on public.devices to authenticated;
         grant update (prefs) on public.devices to authenticated;
         grant all on table public.devices to service_role;`,
        tables
      )
    ).toEqual([]);
  });

  it("cron: a bare call, or one in an unguarded block, is refused; a guarded block passes", () => {
    expect(unguardedCronViolations(`select cron.schedule('j', '* * * * *', $$select 1$$);`)).toEqual([
      'cron.schedule',
    ]);
    expect(
      unguardedCronViolations(`do $$ begin perform cron.unschedule('j'); exception when others then null; end$$;`)
    ).toEqual(['cron.unschedule']);
    expect(
      unguardedCronViolations(`do $$
        begin
          if to_regclass('cron.job') is null then return; end if;
          perform cron.schedule('j', '*/5 * * * *', $job$select public.dsul_tick('/x')$job$);
        end$$;`)
    ).toEqual([]);
  });

  // The guard has to stand in front of the call, not merely share its block.
  it('cron: a block that guards one call and makes the next bare is refused', () => {
    expect(
      unguardedCronViolations(`do $$ begin
        if to_regclass('cron.job') is not null then perform cron.unschedule('dsul-morning'); end if;
        perform cron.schedule('dsul-morning', '0 * * * *', $job$select 1$job$);
      end$$;`)
    ).toEqual(['cron.schedule']);
    // A call ahead of the early exit runs before the exit can.
    expect(
      unguardedCronViolations(`do $$ begin
        perform cron.unschedule('j');
        if to_regclass('cron.job') is null then return; end if;
        perform cron.schedule('j', '* * * * *', $job$select 1$job$);
      end$$;`)
    ).toEqual(['cron.unschedule']);
  });

  it('cron: an early exit inside another IF or a loop guards nothing after it', () => {
    expect(
      unguardedCronViolations(`do $$ begin
        if current_setting('x', true) = 'y' then
          if to_regclass('cron.job') is null then return; end if;
        end if;
        perform cron.schedule('j', '* * * * *', $job$select 1$job$);
      end$$;`)
    ).toEqual(['cron.schedule']);
    expect(
      unguardedCronViolations(`do $$ declare r record; begin
        for r in select 1 from pg_class where false loop
          if to_regclass('cron.job') is null then return; end if;
        end loop;
        perform cron.schedule('j', '* * * * *', $job$select 1$job$);
      end$$;`)
    ).toEqual(['cron.schedule']);
  });

  it("cron: an `is not null` branch guards what is inside it, and not its else", () => {
    expect(
      unguardedCronViolations(`do $$ begin
        if to_regclass('cron.job') is not null then
          if not exists (select 1 from cron.job where jobname = 'j') then
            perform cron.schedule('j', '* * * * *', $job$select 1$job$);
          end if;
          drop table if exists public.t;
          perform cron.alter_job(1, active := true);
        end if;
      end$$;`)
    ).toEqual([]);
    expect(
      unguardedCronViolations(`do $$ begin
        if to_regclass('cron.job') is not null then
          perform cron.unschedule('j');
        else
          perform cron.schedule('j', '* * * * *', $job$select 1$job$);
        end if;
      end$$;`)
    ).toEqual(['cron.schedule']);
  });
});

describe('058_resume_cron_tick', () => {
  const sql = code(RULED.find((f) => f.name === '058_resume_cron_tick.sql')!.text);
  const tick = sql.slice(
    sql.indexOf('create or replace function public.dsul_tick('),
    sql.indexOf('$$;', sql.indexOf('create or replace function public.dsul_tick('))
  );
  /** The function on one line, every run of whitespace a single space, for the tests that read structure. */
  const flat = tick.replace(/\s+/g, ' ');

  it('drops the one-argument tick before creating the two-argument one', () => {
    // With a default on `force`, leaving dsul_tick(text) in place would make the
    // jobs' one-argument call ambiguous between the two.
    const drop = sql.indexOf('drop function if exists public.dsul_tick(text);');
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(drop).toBeLessThan(sql.indexOf('create or replace function public.dsul_tick('));
    expect(tick).toMatch(/dsul_tick\(route text, force boolean default false\)/);
    expect(tick).toMatch(/security definer/);
  });

  it('gates on the three tick rituals and a time zone, with no clock in it', () => {
    // The whole expression, not its words. Each flag and the zone appearing
    // somewhere passed with the ORs turned into ANDs, which would silence the
    // tick for everyone without all three switches on: nearly everyone.
    expect(flat).toContain(
      'where timezone is not null ' +
        'and (coalesce(habit_reminders_enabled, false) ' +
        'or coalesce(stakes_enabled, false) ' +
        'or coalesce(eod_review_enabled, false))'
    );
    // Decision 13: the morning check is not a tier, so it must not wake the tick.
    expect(tick).not.toContain('morning_check');
    // Decision 22, the narrow form: no time-of-day and no interval at all.
    expect(tick).not.toMatch(/\binterval\b|::\s*time\b|\bnow\(\)|current_time|localtime/);
  });

  it('fails OPEN when the gate cannot be read, and only for a schema that is behind', () => {
    expect(tick).toMatch(/when undefined_column or undefined_table then\s+anyone := true;/);
    expect(tick).not.toContain('when others');
  });

  // Which way round the short-circuit runs. Inverted, the tick would fire only
  // when nobody is enabled; with `force` ignored, a Free project's keepalive
  // would never send its one request a day. scripts/verify-058.sh catches both
  // on a real database, but it runs by hand, and the E2E job replays 058
  // without ever calling dsul_tick: this is the check that runs in CI.
  it('asks only when not forced, and returns before the request only when nobody is enabled', () => {
    expect(flat).toMatch(/anyone boolean := true; begin if not force then begin select exists \(/);
    expect(flat).toContain(') into anyone; exception');
    expect(flat).toContain('anyone := true; end; if not anyone then return; end if; end if;');
    // Exactly one way out before the Vault reads, and it is that one.
    const beforeVault = flat.slice(0, flat.indexOf('vault.decrypted_secrets'));
    expect(beforeVault.match(/\breturn;/g)).toEqual(['return;']);
    expect(flat.indexOf('if not anyone then return;')).toBeLessThan(flat.indexOf('net.http_get('));
  });

  it('keeps the Vault names, the fallback, and the 55 s request', () => {
    for (const name of ['dsul_app_url', 'anchor_app_url', 'dsul_cron_secret', 'anchor_cron_secret']) {
      expect(tick).toContain(`'${name}'`);
    }
    expect(tick).toContain("rtrim(app_url, '/') || route");
    expect(tick).toContain('timeout_milliseconds := 55000');
  });

  it('is executable by nobody below the service role', () => {
    expect(sql).toContain(
      'revoke all on function public.dsul_tick(text, boolean) from public, anon, authenticated;'
    );
    expect(sql).not.toMatch(/grant\s+execute\s+on\s+function\s+public\.dsul_tick/);
  });

  it('retires dsul-eod-notify and resumes dsul-reminders, re-creating it only when missing', () => {
    expect(sql).toContain("cron.unschedule('dsul-eod-notify')");
    expect(sql).toMatch(/if not exists \(select 1 from cron\.job where jobname = 'dsul-reminders'\)/);
    expect(sql).toContain("$job$select public.dsul_tick('/api/cron/reminders')$job$");
    expect(sql).toContain('cron.alter_job(j.jobid, active := true)');
    // Every job body inside a `do $$` is a tagged quote: a nested $$ ends the block.
    expect(sql).not.toMatch(/cron\.schedule\([^;]*\$\$/);
  });

  it('leaves the keepalive commented out (decision 1: the project is on Pro)', () => {
    expect(sql).not.toContain('dsul-keepalive');
  });
});
