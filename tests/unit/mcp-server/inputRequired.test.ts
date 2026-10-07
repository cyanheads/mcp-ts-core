/**
 * @fileoverview Unit tests for the multi-round-trip plumbing's two #496
 * primitives: the capability filter over `ctx.inputs` (`declaredResponses`)
 * and the `requestState` sealer built from `MCP_REQUEST_STATE_KEY`. The same
 * pieces are driven through the SDK in `inputRequired.serving.test.ts`.
 * @module tests/unit/mcp-server/inputRequired.test
 */
import { inputRequired, type ServerContext } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRequestStateSealer,
  declaredResponses,
  InputRequiredSignal,
  isInputRequiredSignal,
} from '@/mcp-server/inputRequired.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

const ELICIT = { action: 'accept', content: { ok: true } };
const SAMPLING = { role: 'assistant', content: { type: 'text', text: 'hi' }, model: 'm' };
const ROOTS = { roots: [{ uri: 'file:///work' }] };

describe('isInputRequiredSignal', () => {
  it('recognizes the signal and a value carrying its brand', () => {
    const asking = inputRequired({ inputRequests: { roots: inputRequired.listRoots() } });
    expect(isInputRequiredSignal(new InputRequiredSignal(asking))).toBe(true);
    expect(isInputRequiredSignal({ isInputRequiredSignal: true })).toBe(true);
    expect(isInputRequiredSignal(new Error('boom'))).toBe(false);
  });

  it.each([
    [
      'a revoked Proxy',
      () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      },
    ],
    [
      'a value whose brand getter throws',
      () =>
        Object.defineProperty(new Error('boom'), 'isInputRequiredSignal', {
          get() {
            throw new Error('brand getter');
          },
        }),
    ],
  ])('answers false, never throwing, for %s it cannot inspect (#697)', (_label, make) => {
    expect(isInputRequiredSignal(make())).toBe(false);
  });
});

describe('declaredResponses (#496)', () => {
  const every = { confirm: ELICIT, summary: SAMPLING, roots: ROOTS };

  it.each([
    ['elicitation', { elicitation: {} }, { confirm: ELICIT }],
    ['elicitation.form', { elicitation: { form: {} } }, { confirm: ELICIT }],
    ['sampling', { sampling: {} }, { summary: SAMPLING }],
    ['roots', { roots: {} }, { roots: ROOTS }],
    ['all three', { elicitation: {}, sampling: {}, roots: {} }, every],
  ])('keeps only what %s answers to', (_label, declared, expected) => {
    expect(declaredResponses(every, declared)).toEqual(expected);
  });

  it('keeps a decline and a cancel, which are elicit results too', () => {
    const answers = { a: { action: 'decline' }, b: { action: 'cancel' } };

    expect(declaredResponses(answers, { elicitation: {} })).toEqual(answers);
  });

  it.each([
    ['nothing was declared', {}],
    ['only unrelated capabilities were declared', { experimental: { x: {} } }],
  ])('returns undefined when %s', (_label, declared) => {
    expect(declaredResponses(every, declared)).toBeUndefined();
  });

  it('returns undefined with no view at all, whatever the request carried', () => {
    expect(declaredResponses(every, undefined)).toBeUndefined();
  });

  it('returns undefined when the request carried no responses', () => {
    expect(declaredResponses(undefined, { elicitation: {} })).toBeUndefined();
  });

  it('drops an entry the classifier reads as no kind', () => {
    const responses = { junk: { unrelated: true }, nothing: null, list: [1], confirm: ELICIT };

    expect(declaredResponses(responses, { elicitation: {}, sampling: {}, roots: {} })).toEqual({
      confirm: ELICIT,
    });
  });

  describe('asks of an answer what the gate asks of its request', () => {
    const TOOL_USE = { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} };
    const TOOL_RESULT = { type: 'tool_result', toolUseId: 'call-1', content: [] };
    const answers = {
      form: ELICIT,
      url: { action: 'accept' },
      decline: { action: 'decline' },
      plain: SAMPLING,
      toolArray: { ...SAMPLING, content: [TOOL_USE] },
      toolBlock: { ...SAMPLING, content: TOOL_USE },
      toolResult: { ...SAMPLING, content: [{ type: 'text', text: 'x' }, TOOL_RESULT] },
    };

    it.each([
      ['bare elicitation, read as form', { elicitation: {} }, ['form', 'url', 'decline']],
      ['elicitation.form', { elicitation: { form: {} } }, ['form', 'url', 'decline']],
      ['elicitation.url only', { elicitation: { url: {} } }, ['url', 'decline']],
      ['sampling without tools', { sampling: {} }, ['plain']],
      [
        'sampling.tools',
        { sampling: { tools: {} } },
        ['plain', 'toolArray', 'toolBlock', 'toolResult'],
      ],
    ])('%s', (_label, declared, kept) => {
      expect(Object.keys(declaredResponses(answers, declared) ?? {})).toEqual(kept);
    });
  });

  it('keeps an own __proto__ key as data, never as a prototype', () => {
    const responses = JSON.parse(
      '{"__proto__": {"action": "accept"}, "confirm": {"action": "cancel"}}',
    );

    const kept = declaredResponses(responses, { elicitation: {} });

    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
    expect(Object.keys(kept ?? {})).toEqual(['__proto__', 'confirm']);
  });
});

describe('createRequestStateSealer (MCP_REQUEST_STATE_KEY)', () => {
  const KEY = 'k'.repeat(32);
  const principal = (clientId?: string, subject?: string, tenantId?: string) =>
    ({
      mcpReq: { id: 1 },
      ...(clientId !== undefined && {
        http: { authInfo: { clientId, scopes: [], token: 't', subject, tenantId } },
      }),
    }) as unknown as ServerContext;
  const anonymous = principal();
  const asking = inputRequired({
    inputRequests: { confirm: inputRequired.listRoots() },
    requestState: 'consent/abc',
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is absent when no key is configured', () => {
    expect(createRequestStateSealer(undefined)).toBeUndefined();
  });

  it.each([
    ['31 ASCII bytes', 'k'.repeat(31)],
    ['an empty string', ''],
    ['10 three-byte characters (30 bytes)', '€'.repeat(10)],
  ])('refuses %s with a ConfigurationError naming the variable', (_label, key) => {
    let thrown: unknown;
    try {
      createRequestStateSealer(key);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpError);
    expect(thrown).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      data: { variable: 'MCP_REQUEST_STATE_KEY', minimumBytes: 32 },
    });
    expect((thrown as McpError).message).toContain('MCP_REQUEST_STATE_KEY');
    if (key.length > 0) {
      expect(
        JSON.stringify({ message: (thrown as McpError).message, data: (thrown as McpError).data }),
      ).not.toContain(key);
    }
  });

  it('counts UTF-8 bytes, not characters — 11 three-byte characters are enough', () => {
    expect(createRequestStateSealer('€'.repeat(11))).toBeDefined();
  });

  it('seals the handler state and verifies it back to the original string', async () => {
    const sealer = createRequestStateSealer(KEY);

    const sealed = await sealer?.seal(asking, anonymous);

    expect(sealed?.inputRequests).toEqual(asking.inputRequests);
    expect(sealed?.requestState).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(sealed?.requestState).not.toContain(KEY);
    await expect(sealer?.verify(sealed?.requestState ?? '', anonymous)).resolves.toBe(
      'consent/abc',
    );
  });

  it('returns a result carrying no state untouched', async () => {
    const sealer = createRequestStateSealer(KEY);
    const bare = inputRequired({ inputRequests: { confirm: inputRequired.listRoots() } });

    await expect(sealer?.seal(bare, anonymous)).resolves.toBe(bare);
  });

  describe('refuses what it did not mint for this principal', () => {
    it.each([
      ['a hand-built string', async () => 'consent/abc'],
      [
        'a forged v1 envelope',
        async () => 'v1.eyJwIjoiY29uc2VudC9hYmMiLCJleHAiOjk5OTk5OTk5OTl9.AAAA',
      ],
      [
        'a tampered payload',
        async () => {
          const sealed = (await createRequestStateSealer(KEY)?.seal(asking, anonymous))
            ?.requestState as string;
          const [, body, mac] = sealed.split('.');
          const payload = JSON.parse(Buffer.from(body as string, 'base64url').toString());
          payload.p = 'consent/other';
          return `v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`;
        },
      ],
      [
        'a state sealed under another key',
        async () =>
          (await createRequestStateSealer('z'.repeat(32))?.seal(asking, anonymous))
            ?.requestState as string,
      ],
    ])('%s', async (_label, make) => {
      const sealer = createRequestStateSealer(KEY);

      await expect(sealer?.verify(await make(), anonymous)).rejects.toThrow();
    });

    it.each([
      ['another client', principal('client-b', 'alice', 't1')],
      ['another subject', principal('client-a', 'bob', 't1')],
      ['another tenant', principal('client-a', 'alice', 't2')],
      ['an unauthenticated request', anonymous],
    ])('a state minted for one principal, echoed by %s', async (_label, other) => {
      const sealer = createRequestStateSealer(KEY);
      const minted = principal('client-a', 'alice', 't1');
      const sealed = (await sealer?.seal(asking, minted))?.requestState as string;

      await expect(sealer?.verify(sealed, minted)).resolves.toBe('consent/abc');
      await expect(sealer?.verify(sealed, other)).rejects.toThrow('bind');
    });

    it('a state past its 900 s lifetime', async () => {
      vi.useFakeTimers({ now: new Date('2026-09-26T12:00:00Z') });
      const sealer = createRequestStateSealer(KEY);
      const sealed = (await sealer?.seal(asking, anonymous))?.requestState as string;

      vi.setSystemTime(new Date('2026-09-26T12:15:00Z'));
      await expect(sealer?.verify(sealed, anonymous)).resolves.toBe('consent/abc');

      vi.setSystemTime(new Date('2026-09-26T12:15:02Z'));
      await expect(sealer?.verify(sealed, anonymous)).rejects.toThrow('expired');
    });
  });

  it('verifies a state minted by another sealer holding the same key', async () => {
    const minter = createRequestStateSealer(KEY);
    const verifier = createRequestStateSealer(KEY);
    const sealed = (await minter?.seal(asking, anonymous))?.requestState as string;

    await expect(verifier?.verify(sealed, anonymous)).resolves.toBe('consent/abc');
  });
});
