/**
 * Mirroring a session's transcript to Anthropic's session-ingress service.
 *
 * A remote session run on their cloud writes its transcript there so the local
 * client can follow along, and reads it back when reattaching. There is no
 * such service here — the transcript lives in this app's own SQLite store,
 * which is the only copy and does not need syncing to anyone.
 *
 * The functions stay because sessionStorage.ts calls them on a path that is
 * guarded by "this session has a remote ingress URL", and that guard is where
 * the real answer belongs. appendSessionLog reporting false is honest: nothing
 * was appended anywhere, and the caller logs that and carries on with the
 * local write it had already done.
 */

export type SessionLogEntry = Record<string, unknown>;

export async function appendSessionLog(
  _sessionId: string,
  _entry: unknown,
  _url: string,
): Promise<boolean> {
  return false;
}

export async function getSessionLogs(
  _sessionId: string,
  _url: string,
): Promise<SessionLogEntry[] | null> {
  return null;
}

export async function getSessionLogsViaOAuth(
  _sessionId: string,
  _accessToken: string,
  _orgUUID: string,
): Promise<SessionLogEntry[] | null> {
  return null;
}

export async function getTeleportEvents(
  _sessionId: string,
  _accessToken: string,
  _orgUUID: string,
): Promise<SessionLogEntry[] | null> {
  return null;
}

export function clearSession(_sessionId: string): void {}

export function clearAllSessions(): void {}
