import { Test } from '@nestjs/testing';

import { PasswordService } from './password.service';

describe('PasswordService (Argon2id, ADR-0007)', () => {
  let service: PasswordService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PasswordService],
    }).compile();
    service = moduleRef.get(PasswordService);
  });

  it('hashes with an Argon2id encoded string (algorithm, params, salt embedded)', async () => {
    const hash = await service.hash('hunter2 secure-password');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('hunter2');
  });

  it('verifies the correct password and rejects the wrong one', async () => {
    const hash = await service.hash('correct horse battery staple');
    await expect(service.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(service.verify(hash, 'wrong password')).resolves.toBe(false);
  });

  it('produces distinct salts: two hashes of the same password differ', async () => {
    const a = await service.hash('same-password-value');
    const b = await service.hash('same-password-value');
    expect(a).not.toBe(b);
  });

  it('never returns the plaintext password', async () => {
    const hash = await service.hash('never-echo-me');
    expect(hash).not.toContain('never-echo-me');
  });
});