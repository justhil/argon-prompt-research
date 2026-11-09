export class ArticleSearch {
  constructor(config = {}) {
    this.docs = [];
    this.docMap = new Map();
    this.weights = {
      title: config.titleWeight ?? 3.0,
      tags: config.tagsWeight ?? 2.5,
      body: config.bodyWeight ?? 1.0,
    };
  }

  add(doc) {
    if (!doc || typeof doc !== 'object') {
      throw new TypeError('Document must be an object');
    }

    const normalized = {
      ...doc,
      title: String(doc.title ?? ''),
      body: String(doc.body ?? ''),
      tags: Array.isArray(doc.tags) ? doc.tags.map(t => String(t)) : [],
    };

    const entry = {
      raw: doc,
      normTitle: normalized.title.toLowerCase(),
      normBody: normalized.body.toLowerCase(),
      normTags: normalized.tags.map(t => t.toLowerCase()),
      titleTokens: this._tokenize(normalized.title),
      bodyTokens: this._tokenize(normalized.body),
      tagTokens: normalized.tags.flatMap(t => this._tokenize(t)),
    };

    if (doc.id !== undefined && this.docMap.has(doc.id)) {
      const idx = this.docMap.get(doc.id);
      this.docs[idx] = entry;
    } else {
      if (doc.id !== undefined) {
        this.docMap.set(doc.id, this.docs.length);
      }
      this.docs.push(entry);
    }
    return this;
  }

  remove(id) {
    if (!this.docMap.has(id)) return false;
    const idx = this.docMap.get(id);
    this.docs.splice(idx, 1);
    this.docMap.clear();
    this.docs.forEach((entry, i) => {
      if (entry.raw.id !== undefined) this.docMap.set(entry.raw.id, i);
    });
    return true;
  }

  search(query, options = {}) {
    const {
      tags,
      fields = ['title', 'body', 'tags'],
      operator = 'OR',
      fuzzy = false,
      limit,
      offset = 0,
      includeScore = false,
      highlight = false,
    } = options;

    const rawQuery = String(query ?? '').trim();
    const filterTags = tags
      ? (Array.isArray(tags) ? tags : [tags]).map(t => String(t).toLowerCase())
      : [];

    if (!rawQuery && filterTags.length === 0) {
      return [];
    }

    const { includeTerms, excludeTerms, inlineTags, phrases } = this._parseQuery(rawQuery);
    const activeTags = [...filterTags, ...inlineTags];
    const activeFields = new Set(fields);
    const maxDistance = typeof fuzzy === 'number' ? fuzzy : fuzzy ? 1 : 0;

    const results = [];

    for (const entry of this.docs) {
      // 1. Tag filter (both from options.tags and inline `tag:xxx`)
      if (activeTags.length > 0) {
        const hasAllTags = activeTags.every(t =>
          entry.normTags.some(docTag => docTag === t || docTag.includes(t))
        );
        if (!hasAllTags) continue;
      }

      // 2. Excluded terms (`-word`)
      if (excludeTerms.length > 0) {
        const isExcluded = excludeTerms.some(term =>
          this._matchTermInEntry(term, entry, activeFields, 0) > 0
        );
        if (isExcluded) continue;
      }

      // 3. Exact quoted phrases (`"exact phrase"`)
      let phraseScore = 0;
      if (phrases.length > 0) {
        let allPhrasesMatched = true;
        for (const phrase of phrases) {
          const s = this._matchPhraseInEntry(phrase, entry, activeFields);
          if (s === 0) {
            allPhrasesMatched = false;
            break;
          }
          phraseScore += s;
        }
        if (!allPhrasesMatched) continue;
      }

      // 4. Keyword terms scoring
      let termScore = 0;
      let matchedTerms = 0;

      for (const term of includeTerms) {
        const score = this._matchTermInEntry(term, entry, activeFields, maxDistance);
        if (score > 0) {
          matchedTerms++;
          termScore += score;
        }
      }

      if (includeTerms.length > 0) {
        if (operator.toUpperCase() === 'AND' && matchedTerms < includeTerms.length) {
          continue;
        }
        if (matchedTerms === 0 && phrases.length === 0) {
          continue;
        }
      }

      // Boost when full query matches as a substring or all terms match
      const coverageBoost =
        includeTerms.length > 1 && matchedTerms === includeTerms.length ? 1.5 : 1.0;
      const totalScore = (termScore + phraseScore) * coverageBoost + (activeTags.length > 0 ? 1 : 0);

      if (totalScore > 0) {
        results.push({ entry, score: totalScore });
      }
    }

    results.sort((a, b) => b.score - a.score);

    const sliced =
      typeof limit === 'number'
        ? results.slice(offset, offset + limit)
        : offset > 0
        ? results.slice(offset)
        : results;

    return sliced.map(({ entry, score }) => {
      let docOut = entry.raw;
      if (highlight && rawQuery) {
        const termsToHighlight = [...phrases, ...includeTerms];
        docOut = {
          ...docOut,
          highlights: {
            title: this._highlightText(String(docOut.title ?? ''), termsToHighlight),
            body: this._highlightText(String(docOut.body ?? ''), termsToHighlight),
          },
        };
      }
      if (includeScore) {
        return { ...docOut, score: Number(score.toFixed(4)) };
      }
      return docOut;
    });
  }

  _parseQuery(query) {
    const phrases = [];
    const inlineTags = [];
    const includeTerms = [];
    const excludeTerms = [];

    // Extract quoted phrases
    const withoutQuotes = query.replace(/"([^"]+)"/g, (_, p1) => {
      const clean = p1.trim().toLowerCase();
      if (clean) phrases.push(clean);
      return ' ';
    });

    const rawTokens = withoutQuotes.split(/\s+/).filter(Boolean);
    for (const token of rawTokens) {
      const lower = token.toLowerCase();
      if (lower.startsWith('tag:') && lower.length > 4) {
        inlineTags.push(lower.slice(4));
      } else if (lower.startsWith('-') && lower.length > 1) {
        excludeTerms.push(lower.slice(1));
      } else {
        includeTerms.push(lower);
      }
    }

    return { includeTerms, excludeTerms, inlineTags, phrases };
  }

  _tokenize(text) {
    return String(text)
      .toLowerCase()
      .split(/[\s,.!?;:()[\]{}"'`~@#$%^&*+=|\\/<>]+/)
      .filter(Boolean);
  }

  _matchPhraseInEntry(phrase, entry, activeFields) {
    let score = 0;
    if (activeFields.has('title') && entry.normTitle.includes(phrase)) {
      score += this.weights.title * 2;
    }
    if (activeFields.has('tags') && entry.normTags.some(t => t.includes(phrase))) {
      score += this.weights.tags * 2;
    }
    if (activeFields.has('body') && entry.normBody.includes(phrase)) {
      score += this.weights.body * 2;
    }
    return score;
  }

  _matchTermInEntry(term, entry, activeFields, maxDistance) {
    let score = 0;

    if (activeFields.has('title')) {
      score += this._scoreField(term, entry.normTitle, entry.titleTokens, maxDistance) * this.weights.title;
    }
    if (activeFields.has('tags')) {
      const tagText = entry.normTags.join(' ');
      score += this._scoreField(term, tagText, entry.tagTokens, maxDistance) * this.weights.tags;
    }
    if (activeFields.has('body')) {
      score += this._scoreField(term, entry.normBody, entry.bodyTokens, maxDistance) * this.weights.body;
    }

    return score;
  }

  _scoreField(term, normText, tokens, maxDistance) {
    if (!normText) return 0;

    // Exact token match
    let exactTokenCount = 0;
    for (const t of tokens) {
      if (t === term) exactTokenCount++;
    }
    if (exactTokenCount > 0) {
      return 1 + Math.log1p(exactTokenCount);
    }

    // Substring match (handles CJK & partial words)
    if (normText.includes(term)) {
      let count = 0;
      let pos = 0;
      while ((pos = normText.indexOf(term, pos)) !== -1) {
        count++;
        pos += term.length;
      }
      return 0.8 + Math.min(count * 0.1, 0.5);
    }

    // Fuzzy match against tokens
    if (maxDistance > 0 && term.length >= 3) {
      for (const t of tokens) {
        if (Math.abs(t.length - term.length) <= maxDistance) {
          const dist = this._levenshtein(term, t);
          if (dist <= maxDistance) {
            return 0.5 / (1 + dist);
          }
        }
      }
    }

    return 0;
  }

  _levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }
    return dp[m][n];
  }

  _highlightText(text, terms) {
    if (!text || terms.length === 0) return text;
    const escaped = terms
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (escaped.length === 0) return text;
    const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
    return text.replace(regex, '<mark>$1</mark>');
  }
}
