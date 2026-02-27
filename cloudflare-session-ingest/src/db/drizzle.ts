import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';

export type HyperdriveBinding = { connectionString: string };

export function getDb(hyperdrive: HyperdriveBinding): WorkerDb {
  return getWorkerDb(hyperdrive.connectionString);
}

export type { WorkerDb };
