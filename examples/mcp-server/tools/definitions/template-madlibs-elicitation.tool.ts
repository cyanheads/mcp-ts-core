/**
 * @fileoverview Template Mad Libs tool — demonstrates multi-round-trip input.
 *
 * The handler asks the caller for whatever parts of speech the input omitted by
 * returning `input_required` via `ctx.requestInput(...)`, then reads the
 * answers off `ctx.inputs` when it is re-entered. One code path serves both
 * protocol eras: a 2026-07-28 client fulfils the embedded requests directly,
 * and the SDK's legacy shim fulfils them for a 2025-era session by issuing real
 * `elicitation/create` requests.
 *
 * @module examples/mcp-server/tools/definitions/template-madlibs-elicitation.tool
 */

import { inputRequired, tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

const MISSING_PARTS_HINT =
  'Provide `noun`, `verb`, and `adjective` directly in the input — this client cannot prompt the user mid-call.';

/** The parts of speech the story needs, in the order they are asked for. */
const PARTS = ['noun', 'verb', 'adjective'] as const;
type Part = (typeof PARTS)[number];

const InputSchema = z.object({
  noun: z.string().optional().describe('A noun for the story.'),
  verb: z.string().optional().describe('A verb (past tense) for the story.'),
  adjective: z.string().optional().describe('An adjective for the story.'),
});

const OutputSchema = z.object({
  story: z.string().describe('The final, generated Mad Libs story.'),
  noun: z.string().describe('The noun used in the story.'),
  verb: z.string().describe('The verb used in the story.'),
  adjective: z.string().describe('The adjective used in the story.'),
});

/** The shape each elicitation asks the user to fill in. */
const AnswerSchema = z.object({
  value: z.string().min(1).describe('The word to use in the Mad Libs story.'),
});

export const madlibsElicitationTool = tool('template_madlibs_elicitation', {
  title: 'Mad Libs',
  description:
    'Combine a noun, verb, and adjective into a one-line Mad Libs story. Any parts of speech omitted from the input are requested from the user during execution.',
  input: InputSchema,
  output: OutputSchema,
  auth: ['tool:madlibs:play'],
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
  },

  handler(input, ctx) {
    ctx.log.debug('Processing Mad Libs', { toolInput: input });

    const words: Partial<Record<Part, string>> = {};
    const missing: Part[] = [];

    for (const part of PARTS) {
      const supplied = input[part];
      if (supplied) {
        words[part] = supplied;
        continue;
      }

      // A declined or cancelled prompt is a dead end, not a round to retry —
      // asking again would loop until the round budget runs out.
      const answer = ctx.inputs.view(part);
      if (answer.kind === 'elicit' && answer.action !== 'accept') {
        throw validationError(`User ${answer.action} the ${part} prompt.`, {
          partOfSpeech: part,
          action: answer.action,
          recovery: { hint: MISSING_PARTS_HINT },
        });
      }

      // Schema-validated: the SDK never re-checks accepted content against the
      // schema the request advertised, on either era.
      const accepted = ctx.inputs.accepted(part, AnswerSchema);
      if (accepted) words[part] = accepted.value;
      else missing.push(part);
    }

    if (missing.length > 0) {
      ctx.requestInput({
        inputRequests: Object.fromEntries(
          missing.map((part) => [
            part,
            inputRequired.elicit({
              message: `I need a ${part}. Please provide one below.`,
              requestedSchema: AnswerSchema,
            }),
          ]),
        ),
      });
    }

    const { noun, verb, adjective } = words as Record<Part, string>;
    return { story: `The ${adjective} ${noun} ${verb} over the lazy dog.`, noun, verb, adjective };
  },

  format(result) {
    return [
      { type: 'text', text: result.story },
      {
        type: 'text',
        text: JSON.stringify(
          { noun: result.noun, verb: result.verb, adjective: result.adjective },
          null,
          2,
        ),
      },
    ];
  },
});
