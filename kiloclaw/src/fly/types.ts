/**
 * Type definitions for the Fly.io Machines REST API.
 * Based on https://docs.machines.dev/swagger/index.html
 */

// -- Machine types --

export type FlyMachineState =
  | 'created'
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'suspended'
  | 'replacing'
  | 'destroying'
  | 'destroyed';

/**
 * States accepted by the /wait endpoint (spec.json:1549).
 * Narrower than FlyMachineState — only states you can wait for.
 */
export type FlyWaitableState = 'started' | 'stopped' | 'suspended' | 'destroyed';

export type FlyMachineGuest = {
  cpus: number;
  memory_mb: number;
  cpu_kind?: 'shared' | 'performance';
};

export type FlyMachinePort = {
  port: number;
  handlers?: string[];
};

export type FlyMachineService = {
  ports: FlyMachinePort[];
  internal_port: number;
  protocol: 'tcp' | 'udp';
  autostart?: boolean;
  autostop?: 'off' | 'stop' | 'suspend';
};

export type FlyMachineMount = {
  volume: string;
  path: string;
  name?: string;
};

export type FlyMachineCheck = {
  type: 'http' | 'tcp';
  port: number;
  interval?: string;
  timeout?: string;
  grace_period?: string;
  method?: string;
  path?: string;
};

export type FlyMachineConfig = {
  image: string;
  env?: Record<string, string>;
  guest?: FlyMachineGuest;
  services?: FlyMachineService[];
  checks?: Record<string, FlyMachineCheck>;
  mounts?: FlyMachineMount[];
  metadata?: Record<string, string>;
  auto_destroy?: boolean;
};

export type FlyMachine = {
  id: string;
  name: string;
  state: FlyMachineState;
  region: string;
  instance_id: string;
  config: FlyMachineConfig;
  created_at: string;
  updated_at: string;
};

export type CreateMachineRequest = {
  name?: string;
  region?: string;
  config: FlyMachineConfig;
  skip_launch?: boolean;
};

// -- Volume types --

export type FlyVolume = {
  id: string;
  name: string;
  state: 'created' | 'attached' | 'detached' | 'destroying' | 'destroyed';
  size_gb: number;
  region: string;
  attached_machine_id: string | null;
  created_at: string;
};

/**
 * Hint to Fly about the expected machine spec that will attach to this volume.
 * When provided, Fly places the volume on a host with capacity for the machine,
 * reducing the chance of a 412 "insufficient resources" on subsequent machine creation.
 */
export type VolumeComputeHint = {
  cpu_kind?: 'shared' | 'performance';
  cpus?: number;
  memory_mb?: number;
};

type CreateVolumeBaseRequest = {
  name: string;
  region: string;
  snapshot_retention?: number;
  /** Expected machine spec — helps Fly pick a host with capacity. */
  compute?: VolumeComputeHint;
};

type CreateFreshVolumeRequest = {
  size_gb: number;
  source_volume_id?: never;
};

type CreateForkedVolumeRequest = {
  /** Fork an existing volume. Creates a copy on a different host/region. */
  source_volume_id: string;
  /**
   * Fly rejects size_gb when source_volume_id is set.
   * Forked volume size is inherited from the source volume.
   */
  size_gb?: never;
};

export type CreateVolumeRequest =
  | (CreateVolumeBaseRequest & CreateFreshVolumeRequest)
  | (CreateVolumeBaseRequest & CreateForkedVolumeRequest);

export type CreateVolumeRequestWithoutRegion = Omit<CreateVolumeBaseRequest, 'region'> &
  (CreateFreshVolumeRequest | CreateForkedVolumeRequest);

// -- Volume snapshot types --

export type FlyVolumeSnapshot = {
  id: string;
  created_at: string;
  digest: string;
  retention_days: number;
  size: number;
  status: string;
  volume_size: number;
};

// -- Exec types --

export type MachineExecRequest = {
  command: string[];
  timeout?: number;
};

export type MachineExecResponse = {
  stdout: string;
  stderr: string;
  exit_code: number;
  exit_signal?: number;
};
