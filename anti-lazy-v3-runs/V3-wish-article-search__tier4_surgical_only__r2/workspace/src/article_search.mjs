export class ArticleSearch {
  constructor() {
    this.docs = [];
  }

  add(doc) {
    // doc: { id, title, body, tags?: string[] }
    if (!doc || typeof doc !== 'object') return;
    const normalized = {
      ...doc,
      title: String(doc.title ?? ''),
      body: String(doc.body ?? ''),
      tags: Array.isArray(doc.tags) ? doc.tags.map(t => String(t)) : [],
    };
    const existingIdx = normalized.id !== undefined
      ? this.docs.findIndex(d => d.id === normalized.id)
      : -1;
    if (existingIdx >= 0) {
      this.docs[existingIdx] = normalized;
    } else {
      this.docs.push(normalized);
    }
  }

  search(query, options = {}) {
    const {
      tags,
      matchAll = false,
      limit,
      offset = 0,
      fields = ['title', 'body', 'tags'],
      caseSensitive = false,
    } = options || {};

    const normalize = str => (caseSensitive ? String(str) : String(str).toLowerCase());

    const rawQuery = typeof query === 'string' ? query.trim() : '';
    const terms = rawQuery ? normalize(rawQuery).split(/\s+/).filter(Boolean) : [];
    const filterTags = Array.isArray(tags) && tags.length > 0
      ? tags.map(t => normalize(t))
      : null;

    const scored = [];

    for (const doc of this.docs) {
      const docTitle = normalize(doc.title ?? '');
      const docBody = normalize(doc.body ?? '');
      const docTags = Array.isArray(doc.tags) ? doc.tags.map(t => normalize(t)) : [];

      if (filterTags) {
        const hasTags = filterTags.every(ft => docTags.includes(ft));
        if (!hasTags) continue;
      }

      if (terms.length === 0) {
        if (filterTags) {
          scored.push({ doc, score: 1 });
        }
        continue;
      }

      let matchedTerms = 0;
      let score = 0;

      const fullQuery = normalize(rawQuery);
      if (fields.includes('title') && docTitle.includes(fullQuery)) {
        score += 15;
      }
      if (fields.includes('body') && docBody.includes(fullQuery)) {
        score += 5;
      }

      for (const term of terms) {
        let termScore = 0;

        if (fields.includes('title') && docTitle.includes(term)) {
          termScore += docTitle === term ? 12 : 8;
        }
        if (fields.includes('tags') && docTags.some(t => t.includes(term))) {
          termScore += docTags.includes(term) ? 10 : 6;
        }
        if (fields.includes('body') && docBody.includes(term)) {
          let count = 0;
          let pos = docBody.indexOf(term);
          while (pos !== -1 && count < 5) {
            count++;
            pos = docBody.indexOf(term, pos + term.length);
          }
          termScore += 2 + count;
        }

        if (termScore > 0) {
          matchedTerms++;
          score += termScore;
        }
      }

      const isMatch = matchAll ? matchedTerms === terms.length : matchedTerms > 0;
      if (isMatch) {
        score += (matchedTerms / terms.length) * 10;
        scored.push({ doc, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    let results = scored.map(item => item.doc);
    if (offset > 0 || limit !== undefined) {
      const start = Math.max(0, offset);
      const end = limit !== undefined ? start + Math.max(0, limit) : undefined;
      results = results.slice(start, end);
    }

    return results;
  }
}
