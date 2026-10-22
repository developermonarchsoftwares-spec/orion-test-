import { apiEndpoint, apiMaxConnections } from '../connection-endpoint';

describe('Neon endpoint for the API pool', () => {
  const pooled = 'postgresql://u:p@ep-cool-name-pooler.c-2.us-east-2.aws.neon.tech/db?sslmode=require';
  it('uses the direct endpoint by default, because the pooler rejects the start-up limits', () => {
    expect(apiEndpoint(pooled, {} as any)).toBe('postgresql://u:p@ep-cool-name.c-2.us-east-2.aws.neon.tech/db?sslmode=require');
  });
  it('leaves a direct or local URL alone and keeps the pooler only on request', () => {
    const direct = 'postgresql://u:p@ep-cool-name.c-2.us-east-2.aws.neon.tech/db';
    expect(apiEndpoint(direct, {} as any)).toBe(direct);
    expect(apiEndpoint('postgresql://postgres:x@localhost:5432/orion_db', {} as any)).toContain('localhost');
    expect(apiEndpoint(pooled, { DB_USE_POOLER: 'true' } as any)).toBe(pooled);
  });
  it('defaults to 5 connections per instance on Vercel unless DB_MAX_CONNECTIONS is set', () => {
    expect(apiMaxConnections(20, { VERCEL: '1' } as any)).toBe(5);
    expect(apiMaxConnections(20, { VERCEL: '1', DB_MAX_CONNECTIONS: '10' } as any)).toBe(20); // configured value is the 10 the config already read
    expect(apiMaxConnections(20, {} as any)).toBe(20);
  });
});
