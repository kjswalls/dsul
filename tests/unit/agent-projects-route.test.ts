import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * POST and PATCH /api/agent/projects, the doors dsul_create_project and
 * dsul_update_project plan onto. The db layer is mocked: what is pinned here is
 * the route's own refusals (empty name, a name that folds onto a live project,
 * the trash-held unique name) and what it hands createProject.
 */

const db = vi.hoisted(() => ({
  createProject: vi.fn(),
  findLiveProjectByName: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  renameContainerMembers: vi.fn(),
}));
vi.mock('@/lib/db', () => db);

const ownerRow = { data: { user_id: 'u1' } as { user_id: string } | null };
vi.mock('@/lib/supabase-service', () => ({
  resolveUserIdFromApiKey: async (key: string) => (key === 'good' ? 'u1' : null),
  createServiceClient: () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, is: () => q, single: async () => ownerRow };
      return q;
    },
  }),
}));

import { POST } from '@/app/api/agent/projects/route';
import { PATCH } from '@/app/api/agent/projects/[id]/route';

const req = (body: unknown, key = 'good', method = 'POST') =>
  new NextRequest('http://localhost/api/agent/projects', {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  db.findLiveProjectByName.mockResolvedValue(null);
  db.createProject.mockResolvedValue(undefined);
  db.updateProject.mockResolvedValue(undefined);
  ownerRow.data = { user_id: 'u1' };
});

describe('POST /api/agent/projects', () => {
  it('refuses a bad key', async () => {
    expect((await POST(req({ name: 'YouTube' }, 'bad'))).status).toBe(401);
  });

  it('refuses a missing or blank name before writing', async () => {
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req({ name: '   ' }))).status).toBe(400);
    expect((await POST(req('not json'))).status).toBe(400);
    expect(db.createProject).not.toHaveBeenCalled();
  });

  it('refuses a non-string emoji, colour or notes', async () => {
    expect((await POST(req({ name: 'YouTube', notes: 3 }))).status).toBe(400);
    expect(db.createProject).not.toHaveBeenCalled();
  });

  it('creates with a trimmed name, no icon by default, and its notes', async () => {
    const res = await POST(req({ name: '  YouTube ', notes: 'Weekly devlog' }));
    expect(res.status).toBe(201);
    const [userId, project] = db.createProject.mock.calls[0];
    expect(userId).toBe('u1');
    expect(project).toMatchObject({ name: 'YouTube', emoji: '', notes: 'Weekly devlog' });
    expect((await res.json()).project.name).toBe('YouTube');
  });

  it('answers 409 with the existing project when the name folds onto a live one', async () => {
    const existing = { id: 'p1', name: 'YouTube', emoji: '' };
    db.findLiveProjectByName.mockResolvedValue(existing);
    const res = await POST(req({ name: 'youtube' }));
    expect(res.status).toBe(409);
    expect((await res.json()).project).toEqual(existing);
    expect(db.createProject).not.toHaveBeenCalled();
  });

  it('answers 409, not 500, when the exact name is held in the trash', async () => {
    db.createProject.mockRejectedValue(Object.assign(new Error('duplicate key value'), { code: '23505' }));
    const res = await POST(req({ name: 'YouTube' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/trash/);
  });
});

describe('PATCH /api/agent/projects/:id', () => {
  const params = { params: Promise.resolve({ id: 'p1' }) };

  it('refuses a rename onto another live project in a different case', async () => {
    db.findLiveProjectByName.mockResolvedValue({ id: 'p2', name: 'Work', emoji: '' });
    const res = await PATCH(req({ name: 'work' }, 'good', 'PATCH'), params);
    expect(res.status).toBe(409);
    expect(db.findLiveProjectByName).toHaveBeenCalledWith('u1', 'work', expect.anything(), 'p1');
    expect(db.updateProject).not.toHaveBeenCalled();
  });

  it('refuses a blank name', async () => {
    expect((await PATCH(req({ name: ' ' }, 'good', 'PATCH'), params)).status).toBe(400);
    expect(db.updateProject).not.toHaveBeenCalled();
  });

  it('answers 400, not 500, to a null emoji or a non-object body', async () => {
    expect((await PATCH(req({ emoji: null }, 'good', 'PATCH'), params)).status).toBe(400);
    expect((await PATCH(req('null', 'good', 'PATCH'), params)).status).toBe(400);
    expect(db.updateProject).not.toHaveBeenCalled();
  });

  it('renames with the members carried along', async () => {
    const res = await PATCH(req({ name: 'Sunday Softworks ' }, 'good', 'PATCH'), params);
    expect(res.status).toBe(200);
    expect(db.updateProject).toHaveBeenCalledWith('u1', 'p1', { name: 'Sunday Softworks' }, expect.anything());
    expect(db.renameContainerMembers).toHaveBeenCalledWith('u1', 'p1', 'Sunday Softworks', expect.anything());
  });

  it('leaves the name check out of an icon-only edit', async () => {
    await PATCH(req({ emoji: 'icon:Sparkles' }, 'good', 'PATCH'), params);
    expect(db.findLiveProjectByName).not.toHaveBeenCalled();
    expect(db.updateProject).toHaveBeenCalled();
  });
});
