import { describe, it, expect } from 'vitest';
import { assigneeForName, inQueueOf, roster, sameAssignee } from '@/lib/agent-assignees';

describe('agent assignees', () => {
  it('takes an app by its name, never a name that already means something', () => {
    expect(assigneeForName('  Claude   Code ')).toBe('Claude Code');
    expect(assigneeForName('OpenClaw')).toBeNull();
    expect(assigneeForName('beacon')).toBeNull();
    expect(assigneeForName('')).toBeNull();
    expect(assigneeForName('x'.repeat(61))).toBeNull();
    expect(assigneeForName(3)).toBeNull();
  });

  it('compares names without case or extra space', () => {
    expect(sameAssignee('Claude', ' claude ')).toBe(true);
    expect(sameAssignee('Claude', 'Cursor')).toBe(false);
    expect(sameAssignee(undefined, 'Claude')).toBe(false);
  });

  it("keeps each agent's queue its own", () => {
    expect(inQueueOf('openclaw', 'openclaw')).toBe(true);
    expect(inQueueOf('beacon', 'openclaw')).toBe(true);
    expect(inQueueOf('Claude', 'openclaw')).toBe(false);
    expect(inQueueOf('claude', 'Claude')).toBe(true);
    expect(inQueueOf('openclaw', 'Claude')).toBe(false);
    expect(inQueueOf('', 'Claude')).toBe(false);
  });

  it('lists OpenClaw first when paired, then one row per name', () => {
    expect(
      roster(true, [
        { name: 'Claude', kind: 'app' },
        { name: 'claude', kind: 'app' },
        { name: 'OpenClaw', kind: 'key' },
        { name: 'Cursor', kind: 'key' },
      ]).map((a) => `${a.kind}:${a.name}`)
    ).toEqual(['openclaw:OpenClaw', 'app:Claude', 'key:Cursor']);
    expect(roster(false, [])).toEqual([]);
  });
});
