/**
 * @fileoverview Code review prompt template demonstrating MCP prompts capability.
 * @module examples/mcp-server/prompts/definitions/code-review.prompt
 */
import { prompt, z } from '@cyanheads/mcp-ts-core';

export const codeReviewPrompt = prompt('code_review', {
  description:
    'Generate a structured code review prompt covering quality, security, and performance.',
  args: z.object({
    language: z
      .string()
      .optional()
      .describe('Programming language of the code to review (e.g., "typescript", "python", "rust").'),
    focus: z
      .enum(['security', 'performance', 'style', 'general'])
      .optional()
      .describe("The primary focus area for the code review. Defaults to 'general'."),
    includeExamples: z
      .enum(['true', 'false'])
      .optional()
      .describe("Whether to include example improvements in the review. Defaults to 'false'."),
  }),
  generate: (args) => {
    const focus = args.focus ?? 'general';
    const includeExamples = args.includeExamples === 'true';

    const focusGuidance: Record<string, string> = {
      security:
        '- Security vulnerabilities and potential exploits\n- Input validation and sanitization\n- Authentication and authorization issues\n- Data exposure risks',
      performance:
        '- Algorithmic complexity and bottlenecks\n- Memory usage and leaks\n- Database query optimization\n- Caching opportunities',
      style:
        '- Code readability and clarity\n- Naming conventions\n- Code organization and structure\n- Documentation completeness',
      general:
        '- Overall code quality\n- Security considerations\n- Performance implications\n- Maintainability and readability',
    };

    const examplesSection = includeExamples
      ? '\n\nFor each significant finding, provide a concrete example of how to improve the code.'
      : '';

    return [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `You are an expert code reviewer${args.language ? ` specializing in ${args.language}` : ''}. Please conduct a thorough code review with a focus on ${focus}.

Review the code for:
${focusGuidance[focus] || focusGuidance.general}

Structure your review as follows:
1. **Summary**: 2-3 sentence overview of the code's quality
2. **Key Findings**: Bullet-point list of important observations
3. **Critical Issues**: Any must-fix problems (if found)
4. **Recommendations**: Suggested improvements prioritized by impact${examplesSection}

Be constructive, specific, and actionable in your feedback.`,
        },
      },
    ];
  },
});
