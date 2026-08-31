import type { SessionSummary } from "./session-manager.ts";

export interface SessionTreeNode {
  readonly session: SessionSummary;
  readonly children: readonly SessionTreeNode[];
}

export function buildSessionTree(
  sessions: readonly SessionSummary[],
): readonly SessionTreeNode[] {
  const nodes = new Map<string, MutableSessionTreeNode>();
  for (const session of sessions) {
    nodes.set(session.sessionId, { session, children: [] });
  }
  const roots: MutableSessionTreeNode[] = [];
  for (const session of sessions) {
    const node = nodes.get(session.sessionId)!;
    const parentId = session.parentSessionId;
    const parent = parentId === undefined ? undefined : nodes.get(parentId);
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }
  const sortNodes = (items: MutableSessionTreeNode[]): SessionTreeNode[] =>
    items
      .sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt))
      .map((item) => ({
        session: item.session,
        children: sortNodes(item.children),
      }));
  return sortNodes(roots);
}

interface MutableSessionTreeNode {
  readonly session: SessionSummary;
  readonly children: MutableSessionTreeNode[];
}
