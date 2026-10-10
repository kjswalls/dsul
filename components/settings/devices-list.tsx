'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { Switch } from '@/components/ui/switch';
import { DEVICE_ROSTER_COLUMNS, isMissingRegistry } from '@/lib/devices/db';
import {
  CLAIMS_LOCALLY_COPY,
  DEVICE_KIND_SWITCHES,
  claimsAtDesk,
  claimsLocallyOn,
  coveredByIphoneApp,
  deviceName,
  kindOn,
  withClaimsLocally,
  withKind,
  type RosterRow,
} from '@/lib/devices/roster';
import { storedDeviceId } from '@/lib/devices/web-client';
import { createClient } from '@/lib/supabase';
import type { DeviceSendKind } from '@dsul/types';

/**
 * Rituals → Devices: every device dsul can reach for this account, and which
 * of the reminders each one takes (migration 065).
 *
 * Read through the session client, under 065's column grant: the roster never
 * includes a device's token or keys. A switch writes `prefs` through PostgREST,
 * the one column besides `label` the owner may change. Shows nothing at all
 * while the registry is not there yet (a build ahead of the migration), or
 * while the account has no device.
 */

function ago(at: string | null): string | null {
  if (!at) return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : formatDistanceToNowStrict(d, { addSuffix: true });
}

export function DevicesList() {
  const [rows, setRows] = useState<RosterRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Read once. Nothing renders before the roster arrives, so the server's
  // render (no storage) and the first client render agree either way.
  const [thisId] = useState<string | null>(() => (typeof window === 'undefined' ? null : storedDeviceId()));

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { data, error } = await createClient()
          .from('devices')
          .select(DEVICE_ROSTER_COLUMNS)
          .order('created_at', { ascending: true });
        if (!live) return;
        if (error) {
          if (!isMissingRegistry(error)) setFailed(true);
          setRows([]);
          return;
        }
        setRows((data ?? []) as unknown as RosterRow[]);
      } catch {
        // The network, or no client at all. Say nothing rather than a list
        // that may be wrong.
        if (live) setRows([]);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const savePrefs = useCallback(async (row: RosterRow, prefs: Record<string, unknown>) => {
    setRows((rs) => rs?.map((r) => (r.id === row.id ? { ...r, prefs } : r)) ?? rs);
    const { error } = await createClient()
      .from('devices')
      .update({ prefs })
      .eq('id', row.id)
      .then(
        (r) => r,
        (err: unknown) => ({ error: err })
      );
    if (error) {
      // Put it back: the switch must show what the server holds.
      setRows((rs) => rs?.map((r) => (r.id === row.id ? { ...r, prefs: row.prefs } : r)) ?? rs);
      setFailed(true);
    }
  }, []);

  const toggle = useCallback(
    (row: RosterRow, kind: DeviceSendKind, on: boolean) => savePrefs(row, withKind(row.prefs, kind, on)),
    [savePrefs]
  );
  const toggleClaims = useCallback(
    (row: RosterRow, on: boolean) => savePrefs(row, withClaimsLocally(row.prefs, on)),
    [savePrefs]
  );

  if (!rows || (rows.length === 0 && !failed)) return null;

  return (
    <section className="mt-8" aria-labelledby="devices-heading" data-testid="devices-list">
      <h3 id="devices-heading" className="text-sm font-medium">
        Devices
      </h3>
      <p className="text-muted-foreground mt-1 text-xs">
        Where reminders can reach you. Turn a kind off for one device and the others still get it.
      </p>
      {rows.some(claimsAtDesk) && (
        <p className="text-muted-foreground mt-1 text-xs" data-testid="claims-locally-help">
          {CLAIMS_LOCALLY_COPY.help}
        </p>
      )}
      {failed && (
        <p role="status" className="text-muted-foreground mt-2 text-xs">
          Couldn’t load or save your devices. Try again later.
        </p>
      )}
      <ul className="divide-border mt-2 divide-y">
        {rows.map((row) => {
          const covered = coveredByIphoneApp(row, rows);
          const seen = ago(row.last_seen_at);
          return (
            <li key={row.id} className="py-3" data-device-id={row.device_id}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm">
                  {deviceName(row)}
                  {row.device_id === thisId && (
                    <span className="text-muted-foreground ml-2 text-xs">this browser</span>
                  )}
                </span>
                {seen && <span className="text-muted-foreground shrink-0 text-xs">seen {seen}</span>}
              </div>
              {covered ? (
                <p className="text-muted-foreground mt-1 text-xs">Covered by dsul on this iPhone.</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                  {claimsAtDesk(row) && (
                    <label htmlFor={`device-${row.id}-claims`} className="flex items-center gap-2 text-xs">
                      <Switch
                        id={`device-${row.id}-claims`}
                        checked={claimsLocallyOn(row)}
                        onCheckedChange={(on) => void toggleClaims(row, on)}
                      />
                      {CLAIMS_LOCALLY_COPY.label}
                    </label>
                  )}
                  {DEVICE_KIND_SWITCHES.map(({ kind, label }) => {
                    const id = `device-${row.id}-${kind}`;
                    return (
                      <label key={kind} htmlFor={id} className="flex items-center gap-2 text-xs">
                        <Switch
                          id={id}
                          checked={kindOn(row, kind)}
                          onCheckedChange={(on) => void toggle(row, kind, on)}
                        />
                        {label}
                      </label>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
