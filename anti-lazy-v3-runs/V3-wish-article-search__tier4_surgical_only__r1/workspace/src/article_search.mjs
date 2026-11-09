export class ArticleSearch {
  constructor() {
    this.docs = [];
    this.docMap = new Map();
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

    if (normalized.id !== undefined && this.docMap.has(normalized.id)) {
      const idx = this.docMap.get(normalized.id);
      this.docs[idx] = normalized;
    } else {
      if (normalized.id !== undefined) {
        this.docMap.set(normalized.id, this.docs.length);
      }
      this.docs.push(normalized);
    }
  }

  _tokenize(text, caseSensitive = false) {
    const str = caseSensitive ? String(text ?? '') : String(text ?? '').toLowerCase();
    // Split by whitespace and common punctuation while keeping CJK / word tokens
    return str
      .split(/[\s,.;:!?()[\]{}"'`~@#$%^&*+=|\\/<>]+/)
      .filter(Boolean);
  }

  _scoreField(fieldText, rawQuery, tokens, caseSensitive, weight) {
    if (!fieldText) return 0;
    const text = caseSensitive ? fieldText : fieldText.toLowerCase();
    let score = 0;

    // Exact full query phrase match
    if (rawQuery && text.includes(rawQuery)) {
      score += weight * 3;
      if (text === rawQuery) {
        score += weight * 2;
      } else if (text.startsWith(rawQuery)) {
        score += weight;
      }
    }

    // Individual token matches
    for (const token of tokens) {
      if (!token) continue;
      let pos = text.indexOf(token);
      let count = 0;
      while (pos !== -1) {
        count++;
        pos = text.indexOf(token, pos + token.length);
      }
      if (count > 0) {
        // Diminishing returns for repeated occurrences (TF saturation)
        score += weight * (1 + Math.log1p(count));
      }
    }

    return score;
  }

  search(query, options = {}) {
    const {
      tags,
      matchAllTokens = false,
      caseSensitive = false,
      limit,
      offset = 0,
      minScore = 0,
      weights = {},
      includeScore = false,
    } = options;

    const titleWeight = weights.title ?? 3;
    const tagsWeight = weights.tags ?? 2.5;
    const bodyWeight = weights.body ?? 1;

    const rawQuery = query == null ? '' : String(query).trim();
    const normalizedQuery = caseSensitive ? rawQuery : rawQuery.toLowerCase();
    const tokens = this._tokenize(rawQuery, caseSensitive);

    const filterTags = Array.isArray(tags) && tags.length > 0
      ? tags.map(t => (caseSensitive ? String(t) : String(t).toLowerCase()))
      : null;

    const scoredResults = [];

    for (const doc of this.docs) {
      // 1. Optional tag filtering
      if (filterTags) {
        const docTags = (doc.tags || []).map(t => (caseSensitive ? t : t.toLowerCase()));
        const hasAllFilterTags = filterTags.every(ft => docTags.includes(ft));
        if (!hasAllFilterTags) continue;
      }

      // If empty query, return all docs matching tag filters
      if (!normalizedQuery) {
        scoredResults.push({ doc, score: 1 });
        continue;
      }

      const titleText = caseSensitive ? doc.title : doc.title.toLowerCase();
      const bodyText = caseSensitive ? doc.body : doc.body.toLowerCase();
      const tagsText = (doc.tags || []).map(t => (caseSensitive ? t : t.toLowerCase())).join(' ');
      const combinedText = `${titleText} ${bodyText} ${tagsText}`;

      // 2. Check token matching condition
      if (tokens.length > 0) {
        const tokenMatches = tokens.map(t => combinedText.includes(t));
        const isMatch = matchAllTokens
          ? tokenMatches.every(Boolean)
          : tokenMatches.some(Boolean) || combinedText.includes(normalizedQuery);
        if (!isMatch) continue;
      } else if (!combinedText.includes(normalizedQuery)) {
        continue;
      }

      // 3. Relevance scoring across title, tags, and body
      let score = 0;
      score += this._scoreField(doc.title, normalizedQuery, tokens, caseSensitive, titleWeight);
      score += this._scoreField((doc.tags || []).join(' '), normalizedQuery, tokens, caseSensitive, tagsWeight);
      score += this._scoreField(doc.body, normalizedQuery, tokens, caseSensitive, bodyWeight);

      // Bonus if all query tokens appear in the document
      if (tokens.length > 1) {
        const matchedCount = tokens.filter(t => combinedText.includes(t)).length;
        if (matchedCount === tokens.length) {
          score *= 1.25;
        }
      }

      if (score > minScore) {
        scoredResults.push({ doc, score });
      }
    }

    // Sort by relevance score descending
    if (normalizedQuery) {
      scoredResults.sort((a, b) => b.score - a.score);
    }

    const sliced = limit != null
      ? scoredResults.slice(offset, offset + limit)
      : scoredResults.slice(offset);

    return includeScore
      ? sliced
      : sliced.map(item => item.doc);
  }
}
