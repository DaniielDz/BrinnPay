import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Password hashing with Argon2id (ADR-0007). The encoded string embeds the
 * algorithm, parameters, and salt; only this encoded value is ever stored.
 * Plaintext passwords never leave the request flow into logs or responses.
 */
@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  verify(hash: string, plain: string): Promise<boolean> {
    return argon2.verify(hash, plain).catch(() => false);
  }
}