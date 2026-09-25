/**
 * @fileoverview Code review prompt template demonstrating MCP prompts capability,
 * including argument autocompletion via `completable()`.
 * @module examples/mcp-server/prompts/definitions/code-review.prompt
 */
import { completable, prompt, z } from '@cyanheads/mcp-ts-core';

const LANGUAGES = ['typescript', 'javascript', 'python', 'rust', 'go', 'java'] as const;
const FOCUS_AREAS = ['security', 'performance', 'style', 'general'] as const;

type Focus = (typeof FOCUS_AREAS)[number];

const FOCUS_GUIDANCE = {
  security:
    '- Security vulnerabilities and potential exploits\n- Input validation and sanitization\n- Authentication and authorization issues\n- Data exposure risks',
  performance:
    '- Algorithmic complexity and bottlenecks\n- Memory usage and leaks\n- Database query optimization\n- Caching opportunities',
  style:
    '- Code readability and clarity\n- Naming conventions\n- Code organization and structure\n- Documentation completeness',
  general:
    '- Overall code quality\n- Security considerations\n- Performance implications\n- Maintainability and readability',
} as const satisfies Record<Focus, string>;

/** Fences `code` with one more backtick than its longest backtick run, so embedded fences stay inert. */
function fenceCode(code: string): string {
  const longestRun = Math.max(2, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}\n${code}\n${fence}`;
}

export const codeReviewPrompt = prompt('code_review', {
  title: 'Code Review',
  description:
    'Generate a structured code review prompt covering quality, security, and performance.',
  args: z.object({
    /**
     * completable() wraps the inner schema: the SDK unwraps .optional() before it looks
     * for the completer, so wrapping the optional itself would disable completion.
     */
    language: completable(
      z
        .string()
        .describe(
          'Programming language of the code to review (e.g., "typescript", "python", "rust").',
        ),
      (partial) => LANGUAGES.filter((language) => language.startsWith(partial.toLowerCase())),
    ).optional(),
    focus: z
      .enum(FOCUS_AREAS)
      .optional()
      .describe("The primary focus area for the code review. Defaults to 'general'."),
    includeExamples: z
      .enum(['true', 'false'])
      .optional()
      .describe("Whether to include example improvements in the review. Defaults to 'false'."),
    code: z
      .string()
      .optional()
      .describe('Code to review. When supplied, it is appended as a fenced block.'),
  }),
  generate: (args) => {
    const focus = args.focus ?? 'general';
    const examplesSection =
      args.includeExamples === 'true'
        ? '\n\nFor each significant finding, provide a concrete example of how to improve the code.'
        : '';
    const codeSection = args.code ? `\n\nCode to review:\n\n${fenceCode(args.code)}` : '';

    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `You are an expert code reviewer${args.language ? ` specializing in ${args.language}` : ''}. Please conduct a thorough code review with a focus on ${focus}.

Review the code for:
${FOCUS_GUIDANCE[focus]}

Structure your review as follows:
1. **Summary**: 2-3 sentence overview of the code's quality
2. **Key Findings**: Bullet-point list of important observations
3. **Critical Issues**: Any must-fix problems (if found)
4. **Recommendations**: Suggested improvements prioritized by impact${examplesSection}

Be constructive, specific, and actionable in your feedback.${codeSection}`,
        },
      },
    ];
  },
});
