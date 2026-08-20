/**
 * @fileoverview In-memory session registry for the HTTP transport's sessionful
 * (2025-era) arm.
 *
 * The SDK's streamable HTTP transport owns the protocol side of a session — it
 * mints the ID, rejects unknown ones, stamps `Mcp-Session-Id`, and answers
 * DELETE. This store owns what the SDK deliberately does not: binding a session
 * to the authenticated identity that created it, capping concurrent sessions,
 * expiring idle ones, and holding the `McpServer` + transport pair that serves
 * the session for its lifetime.
 *
 * The 2026-07-28 revision has no session at all, so nothing here applies to it.
 *
 * @see {@link https://modelcontextprotocol.io/specification/2026-07-28/basic/transports | MCP Transports}
 * @module src/mcp-server/transports/http/sessionStore
 */

import type {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';

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
 * The live protocol pair serving one session. Persistent for the session's
 * lifetime, which is what gives 2025-era clients working cancellation, negotiated
 * capabilities, and the SDK's multi-round-trip legacy shim.
 */
export interface SessionConnection {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

/** A stateful MCP session with identity binding and its live connection. */
interface Session {
  clientId?: string;
  connection: SessionConnection;
  createdAt: Date;
  id: string;
  /** Whether identity fields have been bound (atomic snapshot on first write). */
  identityBound: boolean;
  lastAccessedAt: Date;
  subject?: string;
  tenantId?: string;
}

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
    this.cleanupInterval = setInterval(() => void this.cleanupStaleSessions(), 60_000);
    this.cleanupInterval.unref?.();
  }

  /**
   * Stops the cleanup interval and closes every live connection.
   * Call this during transport shutdown to prevent resource leaks.
   */
  async destroy(): Promise<void> {
    clearInterval(this.cleanupInterval);
    const connections = [...this.sessions.values()].map((session) => session.connection);
    this.sessions.clear();
    await Promise.allSettled(connections.map((connection) => closeConnection(connection)));
  }

  /**
   * Throws before a new session's protocol instances are built when the server
   * is already at capacity — allocating them first and discarding them is the
   * expensive way to answer 503.
   *
   * @throws {McpError} `ServiceUnavailable` when at `maxSessions`.
   */
  assertCapacity(): void {
    if (this.sessions.size < this.maxSessions) return;
    const context = requestContextService.createRequestContext({
      operation: 'SessionStore.assertCapacity',
      currentSessions: this.sessions.size,
      maxSessions: this.maxSessions,
    });
    logger.warning('Session capacity reached, rejecting new session', context);
    throw serviceUnavailable(
      `Maximum session capacity reached (${this.maxSessions}). Try again later.`,
      context,
    );
  }

  /**
   * Records a session the SDK transport just initialized, binding it to the
   * identity that created it.
   *
   * @throws {McpError} `InvalidParams` when the session ID format is invalid,
   *   `ServiceUnavailable` when at capacity.
   */
  register(sessionId: string, connection: SessionConnection, identity?: SessionIdentity): void {
    if (!validateSessionIdFormat(sessionId)) {
      const context = requestContextService.createRequestContext({
        operation: 'SessionStore.register',
        sessionIdPrefix: sessionId.substring(0, 16),
      });
      logger.warning('Invalid session ID format rejected', context);
      throw invalidParams(
        'Invalid session ID format. Session IDs must be 64 hexadecimal characters.',
        context,
      );
    }
    this.assertCapacity();

    // Identity is bound atomically as a snapshot on creation.
    const hasIdentity = !!(identity?.tenantId || identity?.clientId || identity?.subject);
    const now = new Date();
    const session: Session = {
      id: sessionId,
      connection,
      createdAt: now,
      lastAccessedAt: now,
      identityBound: hasIdentity,
    };
    if (identity?.tenantId) session.tenantId = identity.tenantId;
    if (identity?.clientId) session.clientId = identity.clientId;
    if (identity?.subject) session.subject = identity.subject;

    this.sessions.set(sessionId, session);
    getSessionMetrics().sessionEventCounter.add(1, { [ATTR_MCP_SESSION_EVENT]: 'created' });
    logger.debug(
      'Session created with identity binding',
      requestContextService.createRequestContext({
        operation: 'SessionStore.register',
        sessionId,
        tenantId: identity?.tenantId,
      }),
    );
  }

  /**
   * The live connection for a session, touching its access time.
   * Call {@link isValidForIdentity} first — this performs no ownership check.
   */
  getConnection(sessionId: string): SessionConnection | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastAccessedAt = new Date();
    return session.connection;
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
   * Binds the identity atomically on the first authenticated request when the
   * session was created unauthenticated.
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
      void this.terminate(sessionId);
      return false;
    }

    // If session has no identity bound, allow (backwards compatibility / no-auth mode)
    if (!session.tenantId && !session.clientId && !session.subject) {
      // Bind atomically on the first authenticated request after an
      // unauthenticated creation. All fields are snapshotted together to
      // prevent chimeric identities from per-field races.
      if (identity && !session.identityBound) {
        const hasIdentity = !!(identity.tenantId || identity.clientId || identity.subject);
        if (hasIdentity) {
          if (identity.tenantId) session.tenantId = identity.tenantId;
          if (identity.clientId) session.clientId = identity.clientId;
          if (identity.subject) session.subject = identity.subject;
          session.identityBound = true;
          logger.debug(
            'Session identity bound atomically on authenticated request',
            requestContextService.createRequestContext({
              operation: 'SessionStore.bindIdentity',
              sessionId,
              tenantId: identity.tenantId,
            }),
          );
        }
      }
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
   * Terminates a session and closes its connection.
   * Idempotent — the SDK transport's own DELETE path also calls this via
   * `onsessionclosed`, after the request that triggered it already removed it.
   */
  async terminate(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.sessions.delete(sessionId);
    const metrics = getSessionMetrics();
    metrics.sessionEventCounter.add(1, { [ATTR_MCP_SESSION_EVENT]: 'terminated' });
    metrics.sessionDuration.record((Date.now() - session.createdAt.getTime()) / 1000);
    logger.info(
      'Session terminated',
      requestContextService.createRequestContext({
        operation: 'SessionStore.terminate',
        sessionId,
      }),
    );
    await closeConnection(session.connection);
  }

  /** Cleans up stale sessions that haven't been accessed recently. */
  private async cleanupStaleSessions(): Promise<void> {
    const now = Date.now();
    const stale: Session[] = [];

    const metrics = getSessionMetrics();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastAccessedAt.getTime() > this.staleTimeout) {
        metrics.sessionDuration.record((now - session.createdAt.getTime()) / 1000);
        this.sessions.delete(id);
        stale.push(session);
      }
    }

    if (stale.length === 0) return;

    metrics.sessionEventCounter.add(stale.length, {
      [ATTR_MCP_SESSION_EVENT]: 'stale_cleanup',
    });
    logger.debug('Cleaned up stale sessions', {
      ...requestContextService.createRequestContext({ operation: 'SessionStore.cleanup' }),
      count: stale.length,
    });
    await Promise.allSettled(stale.map((session) => closeConnection(session.connection)));
  }

  /**
   * Gets the current number of active sessions.
   * @returns The number of sessions
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}

/** Closes a session's server and transport, tolerating either one throwing. */
export async function closeConnection(connection: SessionConnection): Promise<void> {
  const results = await Promise.allSettled([
    connection.transport.close(),
    connection.server.close(),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warning(
        `Failed to close a session surface: ${
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        }`,
      );
    }
  }
}
