// The owner of the test servers (T612, HR-87). Every start of the servers of scripts/test-servers.mts, the first start and a
// start that reuses running servers, names a process that owns them, ORM_SERVERS_OWNER (the Makefile gives the process that
// ran make orm-test-servers, or the make of a CI job). One rule stops them: the servers stop once every owner has ended and
// no run holds a lease of them.
//
// A start holds a shared lease of the owners (.runtime/servers.owners, tests/lease) for its owner before it reads or starts
// the servers, and leaves an owner process (test-servers.mts own). That process waits for the exclusive lease of the owners,
// which it gets once every owner has ended, then for the exclusive lease of the servers (.runtime/servers.leases), which it
// gets once no run holds one (WITH_TEST_ENV, check-run), and stops the servers under both. A lease ends with its holder,
// whether the holder ended, failed or was killed by a signal, so an ended or interrupted run leaves no server that nobody
// holds. The owners have a lease directory of their own, so an owner is no user of the servers: make orm-test-servers-stop
// and a fresh start are refused only by the runs that use them. A start that comes while an owner process stops the servers
// waits for the lease of its owner until they are stopped, and then starts them again.
//
// Each first start writes a new generation into .runtime/servers/generation, and an owner process stops only the servers of
// the generation it watched: servers that were stopped and started again belong to the owners of that later start.

/** The steps of an owner process, in the order own runs them. */
export type OwnerSteps = {
  // waitOwners waits for the exclusive lease of the owners, which is free once every owner has ended.
  waitOwners(): void;
  // holdExclusive waits for the exclusive lease of the servers, which is free once no run holds a shared one.
  holdExclusive(): void;
  // generation reads the generation of the running servers, undefined when none runs.
  generation(): string | undefined;
  stop(): void;
};

// own runs the owner process of the servers of generation. Without both exclusive leases nothing is stopped, and the
// failure is the end of the process.
export function own(generation: string, steps: OwnerSteps): 'stopped' | 'replaced' {
  steps.waitOwners();
  steps.holdExclusive();
  if (steps.generation() !== generation) return 'replaced';
  steps.stop();
  return 'stopped';
}

// ownerPid reads the owner that a start names.
export function ownerPid(env: NodeJS.ProcessEnv): number {
  const value = env.ORM_SERVERS_OWNER ?? '';
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`test-servers: ORM_SERVERS_OWNER is '${value}', not the pid of the process that owns the servers; run make orm-test-servers, which gives it`);
  return Number(value);
}
