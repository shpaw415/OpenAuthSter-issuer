const cache = new Map<string, { value: any; exp: number }>();

export function getCache<Result>(key: string): Result | null {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.exp) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

export function setCache<Result>(key: string, value: Result, ttlMs = 60000) {
  cache.set(key, { value, exp: Date.now() + ttlMs });
}

export function deleteCache(key: string) {
  cache.delete(key);
}
