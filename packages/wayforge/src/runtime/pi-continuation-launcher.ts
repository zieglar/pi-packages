import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ContinuationLauncher, ContinuationLaunchResult } from "../durable/contracts.js";
import type { ContinuationPackage } from "../recovery/continuation.js";
import { renderContinuationPrompt } from "../recovery/continuation.js";
import { invocationId } from "../types/identity.js";
import type { ExecutionResult } from "../types/result.js";
import { failure, success } from "../types/result.js";

export interface PiContinuationSession {
  readonly sessionId: string;
  prompt(text: string): Promise<void>;
}

export interface PiContinuationSessionFactory {
  create(input: { readonly continuationId: string; readonly cwd: string }): Promise<PiContinuationSession>;
}

export interface PiSdkContinuationSessionFactoryOptions {
  readonly cwd: string;
  /** An explicit isolated agent directory; never defaults to production ~/.pi. */
  readonly agentDir: string;
}

/**
 * Public-Pi-SDK factory for a completely fresh, in-memory session. It creates
 * no relationship to the failed session and does not read its transcript.
 */
export class PiSdkContinuationSessionFactory implements PiContinuationSessionFactory {
  constructor(private readonly options: PiSdkContinuationSessionFactoryOptions) {}

  async create(input: { readonly continuationId: string; readonly cwd: string }): Promise<PiContinuationSession> {
    const sessionManager = SessionManager.inMemory(input.cwd);
    const created = await createAgentSession({
      cwd: input.cwd,
      agentDir: this.options.agentDir,
      sessionManager,
    });
    return {
      sessionId: sessionManager.getSessionId(),
      prompt: (text) => created.session.prompt(text, { expandPromptTemplates: false }),
    };
  }
}

export interface PiContinuationLauncherOptions {
  readonly factory: PiContinuationSessionFactory;
}

/**
 * Pi runtime boundary for continuations already authorized by Wayforge's
 * durable state machine. This launches a new Pi invocation only; it does not
 * observe or recover arbitrary top-level Pi provider failures.
 */
export class PiContinuationLauncher implements ContinuationLauncher {
  constructor(private readonly options: PiContinuationLauncherOptions) {}

  async launch(
    packageData: ContinuationPackage,
    preallocatedContinuationId: string,
  ): Promise<ExecutionResult<ContinuationLaunchResult>> {
    if (packageData.continuationId !== preallocatedContinuationId) {
      return failure({
        kind: "validation",
        scope: "task",
        confidence: "certain",
        code: "continuation_identity_mismatch",
        message: "persisted continuation identity does not match the launch intent",
      });
    }

    let session: PiContinuationSession;
    try {
      session = await this.options.factory.create({
        continuationId: preallocatedContinuationId,
        cwd: packageData.workspace.workspaceRoot,
      });
      await session.prompt(renderContinuationPrompt(packageData));
    } catch {
      return failure({
        kind: "provider",
        scope: "invocation",
        confidence: "ambiguous",
        code: "pi_continuation_launch_failed",
        message: "Pi continuation launch did not return an authoritative completion result",
      });
    }
    return success({
      invocationId: invocationId(preallocatedContinuationId),
      sessionId: session.sessionId,
    });
  }
}
