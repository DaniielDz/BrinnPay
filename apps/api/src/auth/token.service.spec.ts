import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';

import { TokenService } from './token.service';

const SECRET = 'unit-test-secret-that-is-long-enough-for-hs256';

describe('TokenService (access JWT, D1)', () => {
  let service: TokenService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: SECRET, signOptions: { expiresIn: '900s' } }),
      ],
      providers: [TokenService],
    }).compile();
    service = moduleRef.get(TokenService);
  });

  it('signs a token and verifies it back to the subject', () => {
    const token = service.signAccessToken('user-123');
    const claims = service.verifyAccessToken(token);
    expect(claims).toEqual({ sub: 'user-123' });
  });

  it('rejects a tampered token', () => {
    const token = service.signAccessToken('user-123');
    const tampered = `${token.slice(0, -4)}AAAA`;
    expect(service.verifyAccessToken(tampered)).toBeNull();
  });

  it('rejects malformed input (not a JWT)', () => {
    expect(service.verifyAccessToken('not-a-jwt')).toBeNull();
    expect(service.verifyAccessToken('')).toBeNull();
  });

  it('rejects an expired token', async () => {
    const expiredService = await buildWithExpiry(-1);
    const token = expiredService.signAccessToken('user-123');
    expect(expiredService.verifyAccessToken(token)).toBeNull();
  });

  async function buildWithExpiry(expiresIn: number): Promise<TokenService> {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET, signOptions: { expiresIn } })],
      providers: [TokenService],
    }).compile();
    return moduleRef.get(TokenService);
  }
});