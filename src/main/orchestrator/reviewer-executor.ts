import type { CodexExecutor, ExecutionContext, ExecutionResult } from './codex-executor';
import { CodexCliExecutor } from './codex-executor';

/**
 * Reviewer executor wraps the Codex CLI but enforces read-only behavior.
 */
export class ReviewerExecutor implements CodexExecutor {
  private readonly delegate: CodexCliExecutor;

  constructor() {
    this.delegate = new CodexCliExecutor();
  }

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    const result = await this.delegate.execute(context);
    return { ...result };
  }
}
