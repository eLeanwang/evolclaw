import { describe, expect, it } from 'vitest';
import { shouldFailFastForMissingOwners } from '../src/config/owner-policy.js';

describe('owner policy', () => {
  it('enables fail-fast only when explicitly requested', () => {
    expect(shouldFailFastForMissingOwners({} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldFailFastForMissingOwners({ EVOLCLAW_REQUIRE_OWNERS: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldFailFastForMissingOwners({ EVOLCLAW_REQUIRE_OWNERS: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldFailFastForMissingOwners({ EVOLCLAW_REQUIRE_OWNERS: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldFailFastForMissingOwners({ EVOLCLAW_REQUIRE_OWNERS: 'yes' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
