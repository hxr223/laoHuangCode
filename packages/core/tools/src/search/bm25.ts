export function searchTokens(text: string): string[] {
  const normalized = text.normalize("NFKC").replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.flatMap(token => {
    if (!/\p{Script=Han}/u.test(token)) return [token];
    const chars = Array.from(token);
    return [...chars, ...chars.slice(1).map((char, index) => chars[index]! + char)];
  });
}

export class Bm25Index {
  private readonly documents: readonly { name: string; length: number }[];
  private readonly postings = new Map<string, Map<number, number>>();
  private readonly averageLength: number;

  constructor(entries: readonly { name: string; text: string }[]) {
    this.documents = entries.map((entry, index) => {
      const tokens = searchTokens(entry.text);
      for (const token of tokens) {
        let posting = this.postings.get(token);
        if (!posting) { posting = new Map(); this.postings.set(token, posting); }
        posting.set(index, (posting.get(index) ?? 0) + 1);
      }
      return { name: entry.name, length: tokens.length };
    });
    this.averageLength = this.documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, this.documents.length) || 1;
  }

  search(query: string, limit: number): string[] {
    const scores = new Map<number, number>();
    for (const token of new Set(searchTokens(query))) {
      const posting = this.postings.get(token);
      if (!posting) continue;
      const idf = Math.log(1 + (this.documents.length - posting.size + 0.5) / (posting.size + 0.5));
      for (const [index, frequency] of posting) {
        const doc = this.documents[index]!;
        const score = idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * doc.length / this.averageLength));
        scores.set(index, (scores.get(index) ?? 0) + score);
      }
    }
    const exact = this.documents.findIndex(doc => doc.name.toLowerCase() === query.trim().toLowerCase());
    if (exact >= 0) scores.set(exact, Number.POSITIVE_INFINITY);
    return [...scores].sort(([a, x], [b, y]) => {
      if (x !== y) return y - x;
      const left = this.documents[a]!.name, right = this.documents[b]!.name;
      return left < right ? -1 : left > right ? 1 : 0;
    }).slice(0, limit).map(([index]) => this.documents[index]!.name);
  }
}
