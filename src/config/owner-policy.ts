export function shouldFailFastForMissingOwners(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.EVOLCLAW_REQUIRE_OWNERS || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}
