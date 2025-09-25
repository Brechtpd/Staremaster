import { spawn } from 'node:child_process';

const DEFAULT_NOTIFICATION_TEXT = 'Codex finished processing.';
const SUMMARY_INPUT_LIMIT = 4000;
const SUMMARY_OUTPUT_LIMIT = 140;
const PRIMARY_MODEL = 'gpt-4o-mini';
const FALLBACK_MODEL = 'gpt-5-codex';

type MaybeModel = string | null;

export interface SummarizeCodexOptions {
  text: string;
  cwd: string;
}

interface CodexExecResult {
  stdout: string;
  stderr: string;
}

export interface ParsedCodexExecMessage {
  message?: string;
  error?: string;
}

export class CodexSummarizer {
  constructor(
    private readonly options: {
      preferredModel?: string;
      fallbackModel?: string | null;
      inputLimit?: number;
      outputLimit?: number;
    } = {}
  ) {}

  async summarize({ text, cwd }: SummarizeCodexOptions): Promise<string> {
    const prepared = this.prepareInput(text);
    if (!prepared) {
      return DEFAULT_NOTIFICATION_TEXT;
    }

    const prompt = this.buildPrompt(prepared);
    const models = this.prepareModelList();
    let lastError: Error | undefined;

    for (const model of models) {
      try {
        const summary = await this.runCodexExec(prompt, cwd, model);
        if (summary) {
          return summary;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error('Failed to summarise Codex output');
  }

  private prepareInput(raw: string): string {
    const normalized = raw.replace(/\r/g, '\n').trim();
    if (!normalized) {
      return '';
    }
    const limit = this.options.inputLimit ?? SUMMARY_INPUT_LIMIT;
    if (normalized.length <= limit) {
      return normalized;
    }
    return normalized.slice(normalized.length - limit);
  }

  private buildPrompt(content: string): string {
    const header = [
      'You are preparing the body text for a desktop notification after a Codex run.',
      'Respond with a single plain-text sentence of at most 140 characters.',
      'Focus on the key outcome or follow-up action, avoid Markdown or quotes.',
      'If the content is empty, respond exactly with "Codex finished processing."',
      '',
      'Codex output to summarise:'
    ];
    return [...header, content].join('\n');
  }

  private prepareModelList(): MaybeModel[] {
    const preferred = this.options.preferredModel ?? PRIMARY_MODEL;
    const fallback = this.options.fallbackModel ?? FALLBACK_MODEL;
    const sequence: MaybeModel[] = [preferred, fallback, null];
    const seen = new Set<MaybeModel>();
    const result: MaybeModel[] = [];
    for (const model of sequence) {
      if (model == null) {
        if (!seen.has(null)) {
          result.push(null);
          seen.add(null);
        }
        continue;
      }
      if (model && !seen.has(model)) {
        result.push(model);
        seen.add(model);
      }
    }
    return result;
  }

  private async runCodexExec(prompt: string, cwd: string, model: MaybeModel): Promise<string> {
    const { stdout, stderr } = await this.executeCodex(prompt, cwd, model);
    const parsed = parseCodexExecJson(stdout);
    if (parsed.message) {
      return this.postProcess(parsed.message);
    }
    const errorMessage = parsed.error ?? stderr.trim();
    throw new Error(errorMessage || 'Codex did not produce a summary');
  }

  private async executeCodex(prompt: string, cwd: string, model: MaybeModel): Promise<CodexExecResult> {
    const args = ['exec', '--json'];
    if (model) {
      args.push('--model', model);
    }
    args.push('-');

    return new Promise<CodexExecResult>((resolve, reject) => {
      const child = spawn('codex', args, {
        cwd,
        env: process.env
      });

      let stdout = '';
      let stderr = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });

      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`codex exec failed with code ${code}: ${stderr || stdout}`));
          return;
        }
        resolve({ stdout, stderr });
      });

      child.stdin.setDefaultEncoding('utf8');
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  private postProcess(message: string): string {
    const limit = this.options.outputLimit ?? SUMMARY_OUTPUT_LIMIT;
    const squashed = message.replace(/\s+/g, ' ').trim();
    if (!squashed) {
      return DEFAULT_NOTIFICATION_TEXT;
    }
    if (squashed.length <= limit) {
      return squashed;
    }
    return `${squashed.slice(0, Math.max(0, limit - 1))}…`;
  }
}

export const parseCodexExecJson = (payload: string): ParsedCodexExecMessage => {
  const lines = payload.split(/\r?\n/);
  let message: string | undefined;
  let error: string | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    try {
      const data = JSON.parse(line) as { msg?: { type?: string; message?: unknown } };
      const type = data.msg?.type;
      if (type === 'agent_message' && typeof data.msg?.message === 'string') {
        message = data.msg.message.trim();
      } else if (type === 'error' && typeof data.msg?.message === 'string') {
        error = data.msg.message.trim();
      }
    } catch {
      // ignore malformed lines
    }
  }

  return { message, error };
};

export const getDefaultNotificationText = (): string => DEFAULT_NOTIFICATION_TEXT;
