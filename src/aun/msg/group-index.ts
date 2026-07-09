import type { AUNClient } from '@agentunion/fastaun';

export async function checkGroupIndex(client: AUNClient, groupId: string): Promise<Record<string, unknown>> {
  return await client.call('group.check_group_index', { group_id: groupId }) as Record<string, unknown>;
}

export async function getGroupIndex(client: AUNClient, groupId: string): Promise<Record<string, unknown>> {
  return await client.call('group.get_group_index', { group_id: groupId }) as Record<string, unknown>;
}
