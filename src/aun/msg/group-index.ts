import type { AUNClient } from '@agentunion/fastaun';

export async function checkGroupIndex(client: AUNClient, groupId: string): Promise<Record<string, unknown>> {
  return await client.group.checkGroupIndex({ group_id: groupId }) as unknown as Record<string, unknown>;
}

export async function getGroupIndex(client: AUNClient, groupId: string): Promise<Record<string, unknown>> {
  return await client.group.getGroupIndex({ group_id: groupId }) as unknown as Record<string, unknown>;
}
