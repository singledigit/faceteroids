// Delete old MicroVM image versions to control storage cost. Keeps the latest
// ACTIVE version (and any other ACTIVE ones); deletes SUCCESSFUL/FAILED inactive
// versions. Image versions incur storage cost even when no VMs run on them.

import {
  DeleteMicrovmImageVersionCommand,
  ListMicrovmImageVersionsCommand,
} from '@aws-sdk/client-lambda-microvms';
import { microvms } from '../lib/aws.js';
import { MICROVM_IMAGE_ARN } from '../config.js';

export async function pruneImages(): Promise<void> {
  const res = await microvms.send(
    new ListMicrovmImageVersionsCommand({ imageIdentifier: MICROVM_IMAGE_ARN }),
  );
  const versions = res.items ?? [];
  const keep = versions.filter((v) => v.status === 'ACTIVE').map((v) => v.imageVersion);
  console.log(`Keeping ACTIVE versions: ${keep.join(', ') || '(none)'}`);

  let deleted = 0;
  for (const v of versions) {
    if (v.status === 'ACTIVE') continue;
    if (v.state === 'DELETING' || v.state === 'DELETED') continue;
    console.log(`Deleting version ${v.imageVersion} (status=${v.status} state=${v.state})`);
    try {
      await microvms.send(
        new DeleteMicrovmImageVersionCommand({
          imageIdentifier: MICROVM_IMAGE_ARN,
          imageVersion: v.imageVersion!,
        }),
      );
      deleted++;
    } catch (err) {
      // A version mid-transition may transiently reject deletion; keep going.
      console.warn(`  skipped ${v.imageVersion}: ${(err as Error).message}`);
    }
  }
  console.log(`Pruned ${deleted} version(s).`);
}
