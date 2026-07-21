/**
 * Background sub-agents.
 *
 * A Task launched with run_in_background runs detached from the parent turn:
 * the parent gets an immediate "launched" result and keeps working, while the
 * child runs under its OWN AbortController (not the turn's — a new user send
 * aborts the turn, and background work must survive that).
 *
 * Two pieces of per-session state:
 *  - `running`: the live controllers, so chat:abort / chat:reset can stop them.
 *  - `pending`: finished reports waiting to be folded into the next user turn
 *    (kept out of the live history until a turn boundary so user/assistant
 *    alternation isn't broken mid-turn).
 */

const running = new Map<string, Set<AbortController>>();
interface BgReport {
  name: string;
  agentType: string;
  description: string;
  report: string;
}
const pending = new Map<string, BgReport[]>();

/**
 * Addressable background agents.
 *
 * Firing a background Task already gave parallelism, but the agents were
 * anonymous: nothing could send a running one a correction, and two of them
 * could not hand anything to each other. A name plus a mailbox is what turns a
 * set of detached tasks into a team.
 */
export interface TeamMember {
  /** Unique within the session; what SendMessage addresses. */
  name: string;
  agentType: string;
  description: string;
  startedAt: number;
  controller: AbortController;
  /** Undelivered messages, drained by the agent between turns. */
  inbox: string[];
}

const team = new Map<string, Map<string, TeamMember>>();

/** Unique member name within a session: "explore", then "explore-2". */
function uniqueName(sessionId: string, base: string): string {
  const members = team.get(sessionId);
  const slug = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  if (!members?.has(slug)) return slug;
  for (let i = 2; ; i++) if (!members.has(`${slug}-${i}`)) return `${slug}-${i}`;
}

export function registerBgAgent(
  sessionId: string,
  controller: AbortController,
  meta?: { agentType?: string; description?: string },
): string {
  const set = running.get(sessionId) ?? new Set<AbortController>();
  set.add(controller);
  running.set(sessionId, set);

  const members = team.get(sessionId) ?? new Map<string, TeamMember>();
  const name = uniqueName(sessionId, meta?.agentType || "agent");
  members.set(name, {
    name,
    agentType: meta?.agentType ?? "agent",
    description: meta?.description ?? "",
    startedAt: Date.now(),
    controller,
    inbox: [],
  });
  team.set(sessionId, members);
  return name;
}

export function unregisterBgAgent(
  sessionId: string,
  controller: AbortController,
): void {
  running.get(sessionId)?.delete(controller);
  const members = team.get(sessionId);
  if (!members) return;
  for (const [name, m] of members) if (m.controller === controller) members.delete(name);
}

/** Who is running right now, for the model and the UI. */
export function listTeam(sessionId: string): Omit<TeamMember, "controller">[] {
  return [...(team.get(sessionId)?.values() ?? [])].map(
    ({ controller: _c, ...rest }) => ({ ...rest, inbox: [...rest.inbox] }),
  );
}

/** Deliver a message to a running agent. Returns false if nobody answers to
 * that name — the sender is told, rather than the message vanishing. */
export function sendToMember(
  sessionId: string,
  to: string,
  from: string,
  text: string,
): boolean {
  const m = team.get(sessionId)?.get(to);
  if (!m) return false;
  m.inbox.push(`<message from="${from}">
${text}
</message>`);
  return true;
}

/** Take and clear an agent's inbox — called between its turns. */
export function drainInbox(sessionId: string, name: string): string[] {
  const m = team.get(sessionId)?.get(name);
  if (!m || m.inbox.length === 0) return [];
  const out = [...m.inbox];
  m.inbox.length = 0;
  return out;
}

/** Stop one member by name. */
export function stopMember(sessionId: string, name: string): boolean {
  const m = team.get(sessionId)?.get(name);
  if (!m) return false;
  m.controller.abort();
  team.get(sessionId)?.delete(name);
  return true;
}

/** Stop every background agent for a session (chat:abort / chat:reset). */
export function abortBgAgents(sessionId: string): void {
  const set = running.get(sessionId);
  if (set) {
    for (const c of set) c.abort();
    set.clear();
  }
  pending.delete(sessionId);
  team.delete(sessionId);
}

/** Stop every background agent across all sessions (chat:abort with no id). */
export function abortAllBgAgents(): void {
  for (const set of running.values()) {
    for (const c of set) c.abort();
    set.clear();
  }
  pending.clear();
  team.clear();
}

/** How many background agents are still running for a session. */
export function countRunningBgAgents(sessionId: string): number {
  return running.get(sessionId)?.size ?? 0;
}

/** Queue a finished report to be delivered to the model on the next turn. */
export function pushBgResult(
  sessionId: string,
  agentType: string,
  description: string,
  report: string,
  name = agentType,
): void {
  const arr = pending.get(sessionId) ?? [];
  arr.push({ name, agentType, description, report });
  pending.set(sessionId, arr);
}

/** Take and clear the pending reports, formatted for injection at a turn
 * boundary (when the model ends its turn without collecting them itself). */
export function drainBgResults(sessionId: string): string[] {
  const arr = pending.get(sessionId);
  if (!arr || arr.length === 0) return [];
  pending.delete(sessionId);
  return arr.map((r) => {
    const label = r.description ? `"${r.name}" (${r.description})` : `"${r.name}"`;
    return (
      `<system-reminder>\nA background sub-agent ${label} has finished. ` +
      `Its report:\n\n${r.report}\n</system-reminder>`
    );
  });
}

/** Take and clear the pending reports as records — for TeamList, which shows
 * them to the model inline rather than as an injected turn. Shares the queue
 * with drainBgResults: whoever reads first delivers them, never both. */
export function collectBgReports(sessionId: string): BgReport[] {
  const arr = pending.get(sessionId);
  if (!arr || arr.length === 0) return [];
  pending.delete(sessionId);
  return arr;
}

/** How many reports are waiting to be collected. */
export function pendingReportCount(sessionId: string): number {
  return pending.get(sessionId)?.length ?? 0;
}
