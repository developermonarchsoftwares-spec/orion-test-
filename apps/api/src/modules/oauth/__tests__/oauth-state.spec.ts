import { OAuthStateService } from '../services/oauth-state.service';

const config = (secret = 'unit-test-access-secret-0123456789abcdef') => ({ get: (k: string) => (k === 'JWT_ACCESS_SECRET' ? secret : undefined) }) as never;

describe('OAuthStateService (sign-in state for Google / Microsoft)', () => {
  it('accepts a state issued by ANOTHER process: start and return can run on different serverless instances', () => {
    const issuedBy = new OAuthStateService(config());
    const returnedTo = new OAuthStateService(config()); // a different instance, or a cold start: it has never seen this state
    const { state } = issuedBy.generateState('google');
    const result = returnedTo.verifyState(state);
    expect(result.valid).toBe(true);
    expect(result.payload?.provider).toBe('google');
  });

  it('accepts a state only once per process (replay is refused)', () => {
    const svc = new OAuthStateService(config());
    const { state } = svc.generateState('google');
    expect(svc.verifyState(state).valid).toBe(true);
    expect(svc.verifyState(state).valid).toBe(false);
    const other = new OAuthStateService(config());
    const { state: s2 } = other.generateState('google');
    expect(other.verifyState(s2).valid).toBe(true);
    expect(other.verifyState(s2).valid).toBe(false); // also when it was issued by this very process
  });

  it('refuses a forged or tampered state', () => {
    const svc = new OAuthStateService(config());
    const { state } = svc.generateState('google');
    const [payload, signature] = state.split('.');
    expect(svc.verifyState('forged-state').valid).toBe(false);
    expect(svc.verifyState(`${payload}.${signature.slice(0, -2)}xx`).valid).toBe(false);
    const tamperedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), provider: 'microsoft' })).toString('base64url');
    expect(svc.verifyState(`${tamperedPayload}.${signature}`).valid).toBe(false);
  });

  it('refuses a state signed with a different secret (another deployment)', () => {
    const { state } = new OAuthStateService(config('a-completely-different-secret-0123456789')).generateState('google');
    expect(new OAuthStateService(config()).verifyState(state).valid).toBe(false);
  });

  it('refuses an expired state (older than 10 minutes)', () => {
    const svc = new OAuthStateService(config());
    const { state } = svc.generateState('google');
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 11 * 60 * 1000;
      expect(svc.verifyState(state).valid).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });
});
