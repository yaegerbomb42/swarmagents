import { describe, it, expect } from 'vitest';
import { buildSwarmHierarchy, mergeOrgSeats, type OrgSeat } from '@/lib/swarmHierarchy';

describe('mergeOrgSeats', () => {
  const base = buildSwarmHierarchy(
    [{ roleId: 'architect', mode: 'auto', options: [] }],
    [],
    [],
  );

  it('adds org seats under architect root', () => {
    const seats: OrgSeat[] = [
      { id: 'seat-a', title: 'API Seat', status: 'running' },
    ];
    const merged = mergeOrgSeats(base, seats);
    expect(merged.some((a) => a.id === 'seat-a' && a.label === 'API Seat')).toBe(true);
    const seat = merged.find((a) => a.id === 'seat-a');
    expect(seat?.parentId).toBe('role:architect');
    expect(seat?.activity).toBe('working');
  });

  it('updates existing agent labels from org seats', () => {
    const seats: OrgSeat[] = [{ id: 'role:architect', title: 'Lead Architect', status: 'active' }];
    const merged = mergeOrgSeats(base, seats);
    const arch = merged.find((a) => a.id === 'role:architect');
    expect(arch?.label).toBe('Lead Architect');
  });
});
