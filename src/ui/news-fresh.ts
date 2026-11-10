/** The items after the last announced one. News is capped and evicts old items, so a count cannot say what is new; an id can. Without a match (first look, or the item was evicted) every item is new. */
export function freshNews<T extends { id: string }>(news: readonly T[], lastId: string | null): T[] {
  const at = lastId === null ? -1 : news.findIndex(n => n.id === lastId);
  return news.slice(at + 1);
}
