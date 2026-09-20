import { RedisService } from '../redis/redis.service';
import { AuthRateLimitService } from './rate-limit.service';

describe('AuthRateLimitService (D7)', () => {
  let redis: { connection: { eval: jest.Mock } };
  let service: AuthRateLimitService;

  beforeEach(() => {
    redis = { connection: { eval: jest.fn() } };
    service = new AuthRateLimitService(redis as unknown as RedisService);
  });

  it('allows requests under the limit', async () => {
    redis.connection.eval.mockResolvedValue(3);
    await expect(service.consume('ip:127.0.0.1', 10, 900)).resolves.toEqual({
      allowed: true,
      remaining: 7,
    });
    expect(redis.connection.eval).toHaveBeenCalled();
  });

  it('blocks requests that exceed the limit', async () => {
    redis.connection.eval.mockResolvedValue(11);
    await expect(service.consume('ip:127.0.0.1', 10, 900)).resolves.toEqual({
      allowed: false,
      remaining: 0,
    });
  });

  it('derives keys from a hash so raw emails/IPs never sit in Redis keys', () => {
    const key = AuthRateLimitService.hashKey('someone@example.com');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(AuthRateLimitService.hashKey('someone@example.com')).not.toContain('example');
  });

  it('does not leak raw values into redis keys', () => {
    redis.connection.eval.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('down'));
    const raw = '127.0.0.1';
    service.consume(`ip:${raw}`, 10, 900).catch(() => undefined);
    const keyArg = redis.connection.eval.mock.calls[0][1] as string;
    expect(keyArg).not.toContain(raw);
  });

  it('falls back to an in-process counter when Redis is unreachable (local-dev fallback)', async () => {
    redis.connection.eval.mockRejectedValue(new Error('redis down'));
    await expect(service.consume('ip:unknown', 2, 900)).resolves.toEqual({ allowed: true, remaining: 1 });
    await expect(service.consume('ip:unknown', 2, 900)).resolves.toEqual({ allowed: true, remaining: 0 });
    await expect(service.consume('ip:unknown', 2, 900)).resolves.toEqual({ allowed: false, remaining: 0 });
  });
});