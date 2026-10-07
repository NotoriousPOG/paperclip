/** Route doubles that do not model scope rows. Every select resolves empty. */
export function unscopedQueryDb<T extends Record<string, unknown>>(extra?: T) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy", "groupBy", "limit", "for"]) {
    chain[method] = self;
  }
  chain.then = (
    resolve: (rows: unknown[]) => unknown,
    reject?: (error: unknown) => unknown,
  ) => Promise.resolve([]).then(resolve, reject);
  return { ...extra, select: () => chain };
}
