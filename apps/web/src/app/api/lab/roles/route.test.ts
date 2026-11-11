import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';
import { synthesizeDomainRole } from '@/lib/lab/agentEvolution';
import { rateLimit } from '@/lib/rateLimit';
import { ROLE_SYNTHESIS_ANON_LIMIT } from '@/lib/lab/labAuth';

vi.mock('@/lib/lab/agentEvolution', () => ({
  synthesizeDomainRole: vi.fn(),
  listSynthesizedRoles: vi.fn(),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(),
}));

const mockSynthesize = vi.mocked(synthesizeDomainRole);
const mockRateLimit = vi.mocked(rateLimit);

function jsonRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = { 'Content-Type': 'application/json' }
): Request {
  return new Request('http://localhost/api/lab/roles', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/lab/roles (role synthesis)', () => {
  beforeEach(() => {
    mockRateLimit.mockResolvedValue({
      allowed: true,
      limit: 10,
      remaining: 9,
      retryAfter: 0,
      backend: 'memory',
    });
    mockSynthesize.mockResolvedValue({ roleId: 'created-role' } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('synthesizes a private role for the resolved identity and passes the rate limit', async () => {
    const res = await POST(jsonRequest({ domainDescription: 'A rust async auditor' }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // No auth header -> anonymous identity, no client IP headers -> IP-scoped key
    expect(mockRateLimit).toHaveBeenCalledWith('lab:roles:create:ip:unknown', ROLE_SYNTHESIS_ANON_LIMIT);

    // Owner is server-derived, creation is unconditionally private
    expect(mockSynthesize).toHaveBeenCalledWith('A rust async auditor', {
      userOrEmail: 'usr-local',
      ownerId: 'usr-local',
      ownerName: 'Anonymous',
      isPublic: false,
    });
  });

  it('returns 429 with rate-limit headers and skips synthesis when over limit', async () => {
    mockRateLimit.mockResolvedValue({
      allowed: false,
      limit: 3,
      remaining: 0,
      retryAfter: 42,
      backend: 'memory',
    });

    const res = await POST(jsonRequest({ domainDescription: 'Another agent' }) as never);

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');

    const body = await res.json();
    expect(body.error).toBe('rate_limited');
    expect(body.retry_after).toBe(42);
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing domain without consuming rate-limit quota', async () => {
    const res = await POST(jsonRequest({ domainDescription: '   ' }) as never);

    expect(res.status).toBe(400);
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockSynthesize).not.toHaveBeenCalled();
  });
});