/**
 * @fileoverview Unit tests for the notifier builders — the three delivery
 * paths a handler's `ctx.notify*` can take, one per era and one fallback.
 * @module tests/unit/mcp-server/notifications.test
 */
import type { ServerEvent, ServerNotifier } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import {
  buildBusNotifiers,
  buildRequestScopedNotifiers,
  notifierFor,
  selectNotifiers,
} from '@/mcp-server/notifications.js';

describe('notifierFor', () => {
  it('maps each method onto its change event', () => {
    const published: ServerEvent[] = [];
    const notify = notifierFor({ publish: (e) => published.push(e), subscribe: () => () => {} });

    notify.toolsChanged();
    notify.promptsChanged();
    notify.resourcesChanged();
    notify.resourceUpdated('probe://item/1');

    expect(published).toEqual([
      { kind: 'tools_list_changed' },
      { kind: 'prompts_list_changed' },
      { kind: 'resources_list_changed' },
      { kind: 'resource_updated', uri: 'probe://item/1' },
    ]);
  });
});

describe('buildBusNotifiers (#193)', () => {
  const spyNotifier = (): ServerNotifier & Record<string, ReturnType<typeof vi.fn>> =>
    ({
      toolsChanged: vi.fn(),
      promptsChanged: vi.fn(),
      resourcesChanged: vi.fn(),
      resourceUpdated: vi.fn(),
    }) as never;

  it('routes each handler notifier to the matching publish method', () => {
    const notify = spyNotifier();
    const notifiers = buildBusNotifiers(notify);

    notifiers.notifyToolListChanged();
    notifiers.notifyResourceListChanged();
    notifiers.notifyPromptListChanged();
    notifiers.notifyResourceUpdated('probe://item/1');

    expect(notify.toolsChanged).toHaveBeenCalledTimes(1);
    expect(notify.resourcesChanged).toHaveBeenCalledTimes(1);
    expect(notify.promptsChanged).toHaveBeenCalledTimes(1);
    expect(notify.resourceUpdated).toHaveBeenCalledWith('probe://item/1');
  });

  it("consults no subscription registry — the listen filter is the SDK's", () => {
    // The 2025 `resources/subscribe` registry does not exist on this era, so
    // gating here would drop every update. Per-URI routing is the listen
    // filter's `resourceSubscriptions` field, applied on publish.
    const notify = spyNotifier();
    buildBusNotifiers(notify).notifyResourceUpdated('probe://never-subscribed');

    expect(notify.resourceUpdated).toHaveBeenCalledWith('probe://never-subscribed');
  });
});

describe('buildRequestScopedNotifiers', () => {
  it('returns undefined when the request scope exposes no sender', () => {
    expect(buildRequestScopedNotifiers({})).toBeUndefined();
  });

  it('gates resource updates on the subscription registry (#354)', () => {
    const notify = vi.fn(async () => {});
    const notifiers = buildRequestScopedNotifiers(
      { notify },
      { has: (uri) => uri === 'sub://yes' },
    );

    notifiers?.notifyResourceUpdated('sub://yes');
    notifiers?.notifyResourceUpdated('sub://no');

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      method: 'notifications/resources/updated',
      params: { uri: 'sub://yes' },
    });
  });

  it('emits every URI when no registry is supplied', () => {
    const notify = vi.fn(async () => {});
    buildRequestScopedNotifiers({ notify })?.notifyResourceUpdated('sub://anything');

    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('selectNotifiers (#193)', () => {
  const serverLevel = {
    notifyToolListChanged: vi.fn(),
    notifyResourceListChanged: vi.fn(),
    notifyPromptListChanged: vi.fn(),
    notifyResourceUpdated: vi.fn(),
  };
  const bus: ServerNotifier = {
    toolsChanged: vi.fn(),
    promptsChanged: vi.fn(),
    resourcesChanged: vi.fn(),
    resourceUpdated: vi.fn(),
  };
  const requestScope = { notify: vi.fn(async () => {}) };

  it('prefers the listen bus over the request scope on a modern instance', () => {
    // Firing through the request scope would bypass the SDK's listen filter
    // and deliver to clients that opted into nothing.
    selectNotifiers({ ...serverLevel, bus }, requestScope).notifyToolListChanged?.();

    expect(bus.toolsChanged).toHaveBeenCalledTimes(1);
    expect(requestScope.notify).not.toHaveBeenCalled();
    expect(serverLevel.notifyToolListChanged).not.toHaveBeenCalled();
  });

  it('falls to the request scope when no bus is supplied (legacy)', () => {
    selectNotifiers(serverLevel, requestScope).notifyToolListChanged?.();

    expect(requestScope.notify).toHaveBeenCalledWith({
      method: 'notifications/tools/list_changed',
    });
    expect(serverLevel.notifyToolListChanged).not.toHaveBeenCalled();
  });

  it('falls to the server-level closures when the scope has no sender', () => {
    // stdio and test harnesses — nothing request-scoped to send through.
    expect(selectNotifiers(serverLevel, undefined)).toBe(serverLevel);
  });
});
