import { ConfigService } from '@nestjs/config';

import { RedisService } from './redis.service';

function configMock(): ConfigService {
  return {
    get: jest.fn((key: string) => (key === 'redisUrl' ? 'redis://localhost:6379' : undefined)),
  } as unknown as ConfigService;
}

describe('RedisService (phase 2 §7.6/D9, readiness + e2e reachability probe)', () => {
  it('establishes the lazy connection before pinging when the client is waiting', async () => {
    const service = new RedisService(configMock());
    const client = service.connection;

    // The real client is lazy-connected (`status` `wait`) and never touches
    // the network in a unit test; connect/ping are mocked.
    jest.spyOn(client, 'connect').mockResolvedValue(undefined as never);
    jest.spyOn(client, 'ping').mockResolvedValue('PONG' as never);

    await expect(service.ping()).resolves.toBeUndefined();
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.ping).toHaveBeenCalledTimes(1);

    service.onModuleDestroy();
  });

  it('does not reconnect when the client is already ready', async () => {
    const service = new RedisService(configMock());
    const client = service.connection;

    jest.spyOn(client, 'connect').mockResolvedValue(undefined as never);
    jest.spyOn(client, 'ping').mockResolvedValue('PONG' as never);
    // Simulate an already-established connection.
    client.status = 'ready';

    await expect(service.ping()).resolves.toBeUndefined();
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.ping).toHaveBeenCalledTimes(1);

    service.onModuleDestroy();
  });

  it('propagates ping failures (dependency unreachable)', async () => {
    const service = new RedisService(configMock());
    const client = service.connection;

    jest.spyOn(client, 'connect').mockResolvedValue(undefined as never);
    jest.spyOn(client, 'ping').mockRejectedValue(new Error('connection refused'));

    await expect(service.ping()).rejects.toThrow('connection refused');

    service.onModuleDestroy();
  });
});