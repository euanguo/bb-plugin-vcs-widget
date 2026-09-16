import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { RepositoryUnavailable, UnavailableKind } from "../contracts";

export interface RepositoryTarget {
  environmentId: string;
  hostId: string;
  repoPath: string;
}

/**
 * Expected states in which a thread has no usable repository; never a crash.
 * Carries the kind so the panels can render one shared empty state without
 * parsing the message.
 */
export class RepositoryUnavailableError extends Error {
  readonly unavailable: RepositoryUnavailable;

  constructor(kind: UnavailableKind, message: string) {
    super(message);
    this.name = "RepositoryUnavailableError";
    this.unavailable = { kind, message };
  }
}

/**
 * Resolves the thread's environment to the machine and absolute worktree path
 * git must run against. `repoPath` only ever comes from bb's own record.
 */
export async function repositoryForThread(
  bb: BbPluginApi,
  threadId: string,
): Promise<RepositoryTarget> {
  const thread = await bb.sdk.threads.get({ threadId, include: "environment" });
  if (!("environment" in thread) || !thread.environment) {
    throw new RepositoryUnavailableError("no_environment", "This thread has no project environment.");
  }
  const environment = thread.environment;
  if (!environment.path) {
    throw new RepositoryUnavailableError("no_workspace", "The thread environment has no workspace path yet.");
  }
  if (environment.status !== "ready") {
    throw new RepositoryUnavailableError("provisioning", `The thread environment is ${environment.status}.`);
  }
  if (environment.isGitRepo === false) {
    throw new RepositoryUnavailableError("not_a_repo", "The thread workspace is not a git repository.");
  }
  return {
    environmentId: environment.id,
    hostId: environment.hostId,
    repoPath: environment.path,
  };
}
