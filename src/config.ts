import { STSClient } from '@aws-sdk/client-sts';

export const DEFAULT_ENDPOINT = 'http://localhost:4566';
export const DEFAULT_TWIN_ACCOUNT = '222222222222';
export const DEFAULT_SNAPSHOT_FILE = 'cloudfork.json';

/** The AWS partition Floci emulates. Twins always live here, whatever the source partition was. */
export const TWIN_PARTITION = 'aws';

export function assertAccountId(accountId: string): string {
  if (!/^\d{12}$/.test(accountId)) {
    throw new Error(`"${accountId}" is not a 12-digit AWS account ID.`);
  }
  return accountId;
}

/** Region from the profile / environment, the same way the AWS CLI resolves it. */
export async function resolveRegion(profile: string | undefined): Promise<string | undefined> {
  const sts = new STSClient(profile ? { profile } : {});
  try {
    return await sts.config.region();
  } catch {
    return undefined;
  } finally {
    sts.destroy();
  }
}
