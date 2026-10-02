// Per-account admission for the live task-board stream.
//
// The task stream is a single process-wide broadcast: every subscriber's callback is invoked for
// every runtime event, regardless of which account produced it. In server mode that would leak one
// account's task board to another, so each connection filters events through a filter that knows
// only its own task ids.
//
// Ownership is decided in this order:
//   1. If the event carries an explicit userId (a later tasks.ts change tags events in announce()),
//      admit only when it matches. This is the fast path once tagging lands.
//   2. Otherwise, admit only ids this account actually owns. An unknown id triggers one refresh of
//      the owned set (so a task created moments ago in this same account is admitted) and is then
//      admitted or dropped. A foreign id is never admitted — a stranger's task can't sneak in even
//      if we cannot prove ownership, because the default is deny.
//
// Kept free of I/O so it can be unit-tested directly (tests/stream-filter.mjs).

export interface FilterableEvent {
  type: string;
  task?: { id: string; userId?: string };
  id?: string;
  userId?: string;
}

export interface AccountFilter {
  /** True when this event may be shown to the account. Records the event in the owned-set. */
  admit(e: FilterableEvent): boolean;
  /** The account's currently-known task ids. */
  ids(): ReadonlySet<string>;
  /** Rebuild the owned-set from storage (called on unknown events and on the periodic sweep). */
  reset(): void;
}

export function makeAccountFilter(uid: string, ownIds: () => Set<string>): AccountFilter {
  let mine = ownIds();
  const idOf = (e: FilterableEvent) => ("task" in e && e.task ? e.task.id : e.id) ?? "";
  return {
    admit(e) {
      const owner = e.task?.userId ?? e.userId;
      if (owner) {
        if (owner !== uid) return false;
      } else {
        const id = idOf(e);
        if (!mine.has(id)) {
          mine = ownIds();
          if (!mine.has(id)) return false;
        }
      }
      if (e.type === "removed") mine.delete(idOf(e));
      else if (e.task) mine.add(e.task.id);
      return true;
    },
    ids: () => mine,
    reset: () => {
      mine = ownIds();
    },
  };
}