/**
 * @fileoverview Simple in-memory session store for MCP HTTP transport.
 * Implements session management as per MCP Spec 2025-06-18.
 * @see {@link https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management | MCP Session Management}
 * @module src/mcp-server/transports/http/sessionStore
 */

import {
  type ClientCapabilities,
  ErrorCode,
  type JSONRPCResponse,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import type { ProtocolSessionHooks } from '@/mcp-server/protocolSession.js';
import { validateSessionIdFormat } from '@/mcp-server/transports/http/sessionIdUtils.js';
import { invalidParams, serviceUnavailable } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { ATTR_MCP_SESSION_EVENT } from '@/utils/telemetry/attributes.js';
import { createCounter, createHistogram } from '@/utils/telemetry/metrics.js';

let sessionEventCounter: ReturnType<typeof createCounter> | undefined;
let sessionDuration: ReturnType<typeof createHistogram> | undefined;

function getSessionMetrics() {
  sessionEventCounter ??= createCounter(
    'mcp.sessions.events',
    'Session lifecycle events',
    '{events}',
  );
  sessionDuration ??= createHistogram(
    'mcp.session.duration',
    'Session duration from creation to termination',
    's',
  );
  return { sessionEventCounter, sessionDuration };
}

/** Eagerly creates the session event counter so the series exists from startup. */
export function initSessionMetrics(): void {
  getSessionMetrics();
}

/**
 * Identity information for binding sessions to authenticated users.
 * Used to prevent session hijacking across tenants/clients.
 */
export interface SessionIdentity {
  /** Client ID from JWT 'cid'/'client_id' claim */
  clientId?: string;
  /** Subject from JWT 'sub' claim */
  subject?: string;
  /** Tenant ID from JWT 'tid' claim */
  tenantId?: string;
}

/**
 * Represents a stateful MCP session with identity binding.
 * Sessions are bound to the authenticated identity to prevent hijacking.
 */
interface Session {
  clientCapabilities?: ClientCapabilities;
  clientId?: string;
  createdAt: Date;
  id: string;
  /** Whether identity fields have been bound (atomic snapshot on first write). */
  identityBound: boolean;
  inFlightRequests: Map<string, Set<AbortController>>;
  lastAccessedAt: Date;
  serverRequests: Map<string, ServerRequestRoute>;
  subject?: string;

  // Identity binding for security
  tenantId?: string;
}

interface ServerRequestRoute {
  deliver: (response: JSONRPCResponse) => void;
  requestId: string;
}

/** Registration for one server-to-client request awaiting a later HTTP POST. */
export interface ServerRequestRegistration {
  /** Session-unique request ID sent to the client. */
  requestId: string;
  /** Removes the route without delivering a response. Safe to call repeatedly. */
  unregister: () => void;
}

/**
 * Simple in-memory session store for stateful MCP sessions.
 * In production, consider using Redis or another persistent store.
 */
/** Default maximum number of concurrent sessions before new ones are rejected. */
const DEFAULT_MAX_SESSIONS = 10_000;

export class SessionStore {
  private sessions: Map<string, Session> = new Map();
  private staleTimeout: number;
  private maxSessions: number;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(staleTimeoutMs: number, maxSessions: number = DEFAULT_MAX_SESSIONS) {
    this.staleTimeout = staleTimeoutMs;
    this.maxSessions = maxSessions;
    // Clean up stale sessions every minute. unref() prevents blocking graceful shutdown.
    this.cleanupInterval = setInterval(() => this.cleanupStaleSessions(), 60_000);
    this.cleanupInterval.unref?.();
  }

  /**
   * Stops the cleanup interval and clears all sessions.
   * Call this during transport shutdown to prevent resource leaks.
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    for (const session of this.sessions.values()) this.endSessionRequests(session);
    this.sessions.clear();
  }

  /**
   * Creates or retrieves a session with optional identity binding.
   * If identity is provided, binds the session to prevent cross-tenant/client hijacking.
   *
   * @param sessionId - The session identifier
   * @param identity - Optional identity info (tenantId, clientId, subject)
   * @returns The session object
   * @throws {McpError} If session ID format is invalid
   */
  getOrCreate(sessionId: string, identity?: SessionIdentity): Session {
    // Validate session ID format to prevent injection attacks
    if (!validateSessionIdFormat(sessionId)) {
      const context = requestContextService.createRequestContext({
        operation: 'SessionStore.getOrCreate',
        sessionIdPrefix: sessionId.substring(0, 16),
      });
      logger.warning('Invalid session ID format rejected', context);
      throw invalidParams(
        'Invalid session ID format. Session IDs must be 64 hexadecimal characters.',
        context,
      );
    }

    let session = this.sessions.get(sessionId);

    if (!session) {
      // Enforce maximum session capacity to prevent unbounded memory growth
      if (this.sessions.size >= this.maxSessions) {
        const context = requestContextService.createRequestContext({
          operation: 'SessionStore.getOrCreate',
          currentSessions: this.sessions.size,
          maxSessions: this.maxSessions,
        });
        logger.warning('Session capacity reached, rejecting new session', context);
        throw serviceUnavailable(
          `Maximum session capacity reached (${this.maxSessions}). Try again later.`,
          context,
        );
      }

      // Build session object conditionally to satisfy exactOptionalPropertyTypes.
      // Identity is bound atomically as a snapshot on creation.
      const hasIdentity = !!(identity?.tenantId || identity?.clientId || identity?.subject);
      const now = new Date();
      const newSession: Session = {
        id: sessionId,
        createdAt: now,
        lastAccessedAt: now,
        identityBound: hasIdentity,
        inFlightRequests: new Map(),
        serverRequests: new Map(),
      };

      // Only set identity fields if they have actual values (not undefined)
      if (identity?.tenantId) newSession.tenantId = identity.tenantId;
      if (identity?.clientId) newSession.clientId = identity.clientId;
      if (identity?.subject) newSession.subject = identity.subject;

      session = newSession;
      this.sessions.set(sessionId, session);
      getSessionMetrics().sessionEventCounter.add(1, { [ATTR_MCP_SESSION_EVENT]: 'created' });
      const context = requestContextService.createRequestContext({
        operation: 'SessionStore.create',
        sessionId,
        tenantId: identity?.tenantId,
      });
      logger.debug('Session created with identity binding', context);
    } else {
      session.lastAccessedAt = new Date();

      // Bind identity atomically on first authenticated request after an
      // unauthenticated session creation. All fields are snapshotted together
      // to prevent chimeric identities from per-field races.
      if (identity && !session.identityBound) {
        const hasIdentity = !!(identity.tenantId || identity.clientId || identity.subject);
        if (hasIdentity) {
          if (identity.tenantId) session.tenantId = identity.tenantId;
          if (identity.clientId) session.clientId = identity.clientId;
          if (identity.subject) session.subject = identity.subject;
          session.identityBound = true;
          const context = requestContextService.createRequestContext({
            operation: 'SessionStore.bindIdentity',
            sessionId,
            tenantId: identity.tenantId,
          });
          logger.debug('Session identity bound atomically on authenticated request', context);
        }
      }
    }

    return session;
  }

  /** Stores capabilities only after the initialize response succeeded. */
  setClientCapabilities(sessionId: string, capabilities: ClientCapabilities): void {
    const session = this.sessions.get(sessionId);
    if (session) session.clientCapabilities = capabilities;
  }

  /**
   * Builds the minimal state hooks restored onto the next per-request server.
   * The session ID remains the isolation boundary for both capability state
   * and cancellation routing.
   */
  createProtocolSessionHooks(sessionId: string): ProtocolSessionHooks | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    return {
      ...(session.clientCapabilities && { clientCapabilities: session.clientCapabilities }),
      registerRequest: (requestId) => this.registerRequest(sessionId, requestId),
    };
  }

  /** Aborts all active handlers with the matching JSON-RPC request ID. */
  cancelRequest(sessionId: string, requestId: RequestId, reason?: string): boolean {
    const controllers = this.sessions
      .get(sessionId)
      ?.inFlightRequests.get(this.requestKey(requestId));
    if (!controllers || controllers.size === 0) return false;

    const abortReason = new DOMException(reason || 'MCP request cancelled', 'AbortError');
    for (const controller of controllers) controller.abort(abortReason);
    return true;
  }

  /**
   * Registers a server-to-client request whose response will arrive on a later
   * HTTP POST handled by a different SDK Server instance.
   *
   * Each per-request SDK Server starts its outbound request counter at zero, so
   * the wire ID is replaced with a session-unique value. The caller restores
   * the original ID before delivering the response to the originating Server.
   */
  registerServerRequest(
    sessionId: string,
    deliver: (response: JSONRPCResponse) => void,
  ): ServerRequestRegistration | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const requestId = `server-${crypto.randomUUID()}`;
    const key = this.requestKey(requestId);
    const route: ServerRequestRoute = { requestId, deliver };
    session.serverRequests.set(key, route);

    let registered = true;
    return {
      requestId,
      unregister: () => {
        if (!registered) return;
        registered = false;
        if (session.serverRequests.get(key) === route) session.serverRequests.delete(key);
      },
    };
  }

  /** Routes one client response back to the per-request Server that emitted it. */
  routeServerResponse(sessionId: string, response: JSONRPCResponse): boolean {
    if (response.id === undefined) return false;
    const routes = this.sessions.get(sessionId)?.serverRequests;
    const route = routes?.get(this.requestKey(response.id));
    if (!routes || !route) return false;

    routes.delete(this.requestKey(response.id));
    route.deliver(response);
    return true;
  }

  private requestKey(requestId: RequestId): string {
    return `${typeof requestId}:${String(requestId)}`;
  }

  private registerRequest(sessionId: string, requestId: RequestId) {
    const session = this.sessions.get(sessionId);
    const controller = new AbortController();
    if (!session) {
      return { signal: controller.signal, unregister: () => undefined };
    }

    const key = this.requestKey(requestId);
    const controllers = session.inFlightRequests.get(key) ?? new Set<AbortController>();
    controllers.add(controller);
    session.inFlightRequests.set(key, controllers);
    let registered = true;

    return {
      signal: controller.signal,
      unregister: () => {
        if (!registered) return;
        registered = false;
        controllers.delete(controller);
        if (controllers.size === 0) session.inFlightRequests.delete(key);
      },
    };
  }

  private endSessionRequests(session: Session): void {
    const reason = new DOMException('MCP session ended', 'AbortError');
    for (const controllers of session.inFlightRequests.values()) {
      for (const controller of controllers) controller.abort(reason);
    }
    session.inFlightRequests.clear();

    const routes = [...session.serverRequests.values()];
    session.serverRequests.clear();
    for (const route of routes) {
      route.deliver({
        jsonrpc: '2.0',
        id: route.requestId,
        error: {
          code: ErrorCode.ConnectionClosed,
          message: 'MCP session ended',
        },
      });
    }
  }

  /**
   * Validates a session with identity binding checks.
   * Prevents session hijacking by verifying the session belongs to the requesting identity.
   *
   * Security checks:
   * 1. Session existence
   * 2. Staleness timeout
   * 3. Tenant ID match (if session has tenantId)
   * 4. Client ID match (if session has clientId)
   * 5. Subject match (if session has subject)
   *
   * @param sessionId - The session identifier
   * @param identity - The identity to validate against (from auth)
   * @returns True if session is valid and matches identity
   */
  isValidForIdentity(sessionId: string, identity?: SessionIdentity): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    // Check staleness
    if (Date.now() - session.lastAccessedAt.getTime() > this.staleTimeout) {
      this.terminate(sessionId);
      return false;
    }

    // If session has no identity bound, allow (backwards compatibility / no-auth mode)
    if (!session.tenantId && !session.clientId && !session.subject) {
      return true;
    }

    // Lazy-create context only when a warning is likely
    const warn = (message: string, extra?: Record<string, unknown>) => {
      const context = requestContextService.createRequestContext({
        operation: 'SessionStore.isValidForIdentity',
        sessionId,
      });
      logger.warning(message, extra ? { ...context, ...extra } : context);
    };

    // If request has no identity but session does, reject (security: session was authenticated)
    if (!identity) {
      warn('Session requires authentication but request has no identity');
      getSessionMetrics().sessionEventCounter.add(1, { [ATTR_MCP_SESSION_EVENT]: 'rejected' });
      return false;
    }

    // Verify tenant ID match — reject if session is bound but request lacks or mismatches
    if (session.tenantId && session.tenantId !== identity.tenantId) {
      warn('Session tenant mismatch - possible hijacking attempt', {
        sessionTenant: session.tenantId,
        requestTenant: identity.tenantId,
      });
      getSessionMetrics().sessionEventCounter.add(1, { [ATTR_MCP_SESSION_EVENT]: 'rejected' });
      return false;
    }

    // Verify client ID match — reject if session is bound but request lacks or mismatches
    if (session.clientId && session.clientId !== identity.clientId) {
      warn('Session client mismatch - possible hijacking attempt', {
        sessionClient: session.clientId,
        requestClient: identity.clientId,
      });
      getSessionMetrics().sessionEventCounter.add(1, { [ATTR_MCP_SESSION_EVENT]: 'rejected' });
      return false;
    }

    // Verify subject match — reject if session is bound but request lacks or mismatches
    if (session.subject && session.subject !== identity.subject) {
      warn('Session subject mismatch - possible hijacking attempt', {
        sessionSubject: session.subject,
        requestSubject: identity.subject,
      });
      getSessionMetrics().sessionEventCounter.add(1, { [ATTR_MCP_SESSION_EVENT]: 'rejected' });
      return false;
    }

    return true;
  }

  /**
   * Terminates a session.
   * @param sessionId - The session identifier
   */
  terminate(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.endSessionRequests(session);
      this.sessions.delete(sessionId);
      const metrics = getSessionMetrics();
      metrics.sessionEventCounter.add(1, { [ATTR_MCP_SESSION_EVENT]: 'terminated' });
      metrics.sessionDuration.record((Date.now() - session.createdAt.getTime()) / 1000);
      const context = requestContextService.createRequestContext({
        operation: 'SessionStore.terminate',
        sessionId,
      });
      logger.info('Session terminated', context);
    }
  }

  /**
   * Cleans up stale sessions that haven't been accessed recently.
   */
  private cleanupStaleSessions(): void {
    const now = Date.now();
    let cleanedCount = 0;

    const metrics = getSessionMetrics();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastAccessedAt.getTime() > this.staleTimeout) {
        this.endSessionRequests(session);
        metrics.sessionDuration.record((now - session.createdAt.getTime()) / 1000);
        this.sessions.delete(id);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      metrics.sessionEventCounter.add(cleanedCount, {
        [ATTR_MCP_SESSION_EVENT]: 'stale_cleanup',
      });
      const context = requestContextService.createRequestContext({
        operation: 'SessionStore.cleanup',
      });
      logger.debug('Cleaned up stale sessions', {
        ...context,
        count: cleanedCount,
      });
    }
  }

  /**
   * Gets the current number of active sessions.
   * @returns The number of sessions
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}
