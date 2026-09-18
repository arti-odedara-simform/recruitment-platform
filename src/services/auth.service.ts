import { UnauthorizedError } from '../errors/AppError.js';
import { simulatePasswordVerification, verifyPassword } from '../auth/password.js';
import { TOKEN_TTL_SECONDS, signAccessToken } from '../auth/tokens.js';
import {
  findUserById,
  findUserCredentialsByEmail,
  type PublicUser,
} from '../repositories/user.repository.js';

export interface LoginResult {
  token: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: PublicUser;
}

/**
 * One message, one status, for both "no such email" and "wrong password".
 *
 * Distinguishing them would turn the login endpoint into an account-enumeration oracle:
 * a recruiter's address is exactly the kind of contact detail the rest of this POC works
 * to keep out of interviewer-reachable responses (PLAN.md §1), and it would be odd to
 * hand it back here.
 */
function invalidCredentials(): UnauthorizedError {
  return new UnauthorizedError('Invalid email or password.');
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const user = await findUserCredentialsByEmail(email);

  if (!user) {
    // Burn the same ~250ms the real path spends in bcrypt before failing — see the note
    // on simulatePasswordVerification. Without it the 401s are identical in body and
    // distinguishable by stopwatch.
    await simulatePasswordVerification(password);
    throw invalidCredentials();
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    throw invalidCredentials();
  }

  const { passwordHash: _passwordHash, ...publicUser } = user;

  return {
    token: signAccessToken({ id: user.id, role: user.role }),
    tokenType: 'Bearer',
    expiresIn: TOKEN_TTL_SECONDS,
    user: publicUser,
  };
}

/**
 * Resolves the token's subject against the database rather than echoing the claims.
 *
 * Tokens are stateless and valid for their full 15 minutes, so a user deleted mid-window
 * still holds a signature that verifies. This read is what makes `GET /auth/me` answer
 * "who am I *now*" — and it 401s if the subject no longer exists.
 */
export async function describeActor(actorId: string): Promise<PublicUser> {
  const user = await findUserById(actorId);
  if (!user) {
    throw new UnauthorizedError('The account this token was issued for no longer exists.');
  }
  return user;
}
