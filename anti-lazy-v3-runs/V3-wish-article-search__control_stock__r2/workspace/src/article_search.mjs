export class ArticleSearch {
  constructor(config = {}) {
    this.docs = [];
    this.weights = {
      title: 3.0,
      tags: 2.5,
      body: 1.0,
      ...config.weights,
    };
  }

  add(doc) {
    if (!doc || typeof doc !== 'object') return this;
    const normalized = {
      ...doc,
      title: String(doc.title ?? ''),
      body: String(doc.body ?? ''),
      tags: Array.isArray(doc.tags) ? doc.tags.map(String) : [],
    };
    if (normalized.id !== undefined) {
      const existingIdx = this.docs.findIndex(d => d.id === normalized.id);
      if (existingIdx !== -1) {
        this.docs[existingIdx] = normalized;
        return this;
      }
    }
    this.docs.push(normalized);
    return this;
  }

  addAll(docs = []) {
    for (const doc of docs) this.add(doc);
    return this;
  }

  remove(id) {
    const before = this.docs.length;
    this.docs = this.docs.filter(d => d.id !== id);
    return this.docs.length < before;
  }

  clear() {
    this.docs = [];
  }

  _parseQuery(rawQuery, caseSensitive = false) {
    const q = caseSensitive ? String(rawQuery ?? '').trim() : String(rawQuery ?? '').trim().toLowerCase();
    const phrases = [];
    const mustNot = [];
    const tagFilters = [];
    const terms = [];

    const regex = /"([^"]+)"|(-?\S+)/g;
    let match;
    while ((match = regex.exec(q)) !== null) {
      if (match[1] !== undefined) {
        const phrase = match[1].trim();
        if (phrase) phrases.push(phrase);
      } else if (match[2]) {
        const token = match[2];
        if (token.startsWith('-') && token.length > 1) {
          mustNot.push(token.slice(1));
        } else if (token.toLowerCase().startsWith('tag:') && token.length > 4) {
          tagFilters.push(token.slice(4));
        } else {
          terms.push(token);
        }
      }
    }

    return { raw: q, phrases, terms, mustNot, tagFilters };
  }

  _levenshtein(a, b, maxDistance = 2) {
    if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
    for (let j = 1; j <= b.length; j++) {
      let prev = dp[0];
      dp[0] = j;
      let minRow = dp[0];
      for (let i = 1; i <= a.length; i++) {
        const temp = dp[i];
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + cost);
        prev = temp;
        if (dp[i] < minRow) minRow = dp[i];
      }
      if (minRow > maxDistance) return maxDistance + 1;
    }
    return dp[a.length];
  }

  _scoreField(text, term, { fuzzy = false } = {}) {
    if (!text || !term) return 0;
    let score = 0;

    // Exact full or substring matches
    if (text === term) {
      score += 5;
    } else if (text.startsWith(term)) {
      score += 3.5;
    }

    let idx = text.indexOf(term);
    let occurrences = 0;
    while (idx !== -1) {
      occurrences++;
      idx = text.indexOf(term, idx + term.length);
    }

    if (occurrences > 0) {
      // Logarithmic TF saturation
      score += 2 * (1 + Math.log1p(occurrences));
      return score;
    }

    // Optional fuzzy match on words
    if (fuzzy && term.length >= 3) {
      const maxDist = typeof fuzzy === 'number' ? fuzzy : (term.length >= 6 ? 2 : 1);
      const words = text.split(/[\s,.;:!?()[\]{}"'`~@#$%^&*+=|\\/<>]+/).filter(Boolean);
      for (const w of words) {
        const dist = this._levenshtein(w, term, maxDist);
        if (dist <= maxDist) {
          score += Math.max(0.5, 1.5 - dist * 0.5);
          break;
        }
      }
    }

    return score;
  }

  _highlightText(text, tokens, caseSensitive = false) {
    if (!text || !tokens.length) return text;
    const escaped = tokens
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!escaped.length) return text;
    const re = new RegExp(`(${escaped.join('|')})`, caseSensitive ? 'g' : 'gi');
    return text.replace(re, '<mark>$1</mark>');
  }

  search(query, options = {}) {
    if (query === null || query === undefined) return [];
    const {
      fields = ['title', 'body', 'tags'],
      tags = null,
      operator = 'OR',
      fuzzy = false,
      caseSensitive = false,
      minScore = 0,
      limit = Infinity,
      offset = 0,
      includeScore = false,
      highlight = false,
      weights = {},
    } = options;

    const fieldWeights = { ...this.weights, ...weights };
    const norm = s => (caseSensitive ? String(s ?? '') : String(s ?? '').toLowerCase());

    const rawStr = String(query).trim();
    if (!rawStr) {
      if (tags) {
        const requiredTags = (Array.isArray(tags) ? tags : [tags]).map(norm);
        return this.docs
          .filter(d => {
            const docTags = (d.tags || []).map(norm);
            return requiredTags.every(t => docTags.includes(t));
          })
          .slice(offset, offset + limit);
      }
      return [];
    }

    const parsed = this._parseQuery(rawStr, caseSensitive);
    const activeTags = [
      ...parsed.tagFilters,
      ...(tags ? (Array.isArray(tags) ? tags : [tags]).map(norm) : []),
    ];
    const searchTokens = [...parsed.phrases, ...parsed.terms];

    const results = [];

    for (const doc of this.docs) {
      const titleText = norm(doc.title);
      const bodyText = norm(doc.body);
      const docTags = (doc.tags || []).map(norm);
      const tagsText = docTags.join(' ');

      // 1. Tag filter check
      if (activeTags.length > 0) {
        const hasAllTags = activeTags.every(reqTag =>
          docTags.some(t => t === reqTag || t.includes(reqTag))
        );
        if (!hasAllTags) continue;
      }

      // 2. Exclusion (-term) check
      if (parsed.mustNot.length > 0) {
        const excluded = parsed.mustNot.some(
          neg => titleText.includes(neg) || bodyText.includes(neg) || tagsText.includes(neg)
        );
        if (excluded) continue;
      }

      // If query only had tag filters / exclusions and no search tokens
      if (searchTokens.length === 0) {
        results.push({ doc, score: 1 });
        continue;
      }

      // 3. Score each token across active fields
      let totalScore = 0;
      let matchedTokens = 0;

      for (const token of searchTokens) {
        let tokenScore = 0;
        if (fields.includes('title')) {
          tokenScore += this._scoreField(titleText, token, { fuzzy }) * (fieldWeights.title ?? 3);
        }
        if (fields.includes('tags') && docTags.length > 0) {
          for (const t of docTags) {
            tokenScore += this._scoreField(t, token, { fuzzy }) * (fieldWeights.tags ?? 2.5);
          }
        }
        if (fields.includes('body')) {
          tokenScore += this._scoreField(bodyText, token, { fuzzy }) * (fieldWeights.body ?? 1);
        }

        if (tokenScore > 0) {
          matchedTokens++;
          totalScore += tokenScore;
        }
      }

      // Full raw query phrase bonus when multiple tokens are used
      if (searchTokens.length > 1) {
        const fullNorm = norm(rawStr);
        if (fields.includes('title') && titleText.includes(fullNorm)) {
          totalScore += 4 * (fieldWeights.title ?? 3);
        }
        if (fields.includes('body') && bodyText.includes(fullNorm)) {
          totalScore += 2 * (fieldWeights.body ?? 1);
        }
      }

      const isAnd = String(operator).toUpperCase() === 'AND';
      const matchesEnough = isAnd
        ? matchedTokens === searchTokens.length
        : matchedTokens > 0;

      if (matchesEnough && totalScore > minScore) {
        // Multi-token coverage boost
        const coverageBoost = 1 + (matchedTokens / searchTokens.length) * 0.5;
        results.push({ doc, score: Number((totalScore * coverageBoost).toFixed(4)) });
      }
    }

    results.sort((a, b) => b.score - a.score);

    const sliced = results.slice(offset, offset + limit);

    return sliced.map(({ doc, score }) => {
      if (!includeScore && !highlight) {
        const item = { ...doc };
        Object.defineProperty(item, 'score', { value: score, enumerable: false });
        return item;
      }
      const item = { ...doc };
      if (includeScore) item.score = score;
      if (highlight) {
        item.highlights = {
          title: this._highlightText(doc.title, searchTokens, caseSensitive),
          body: this._highlightText(doc.body, searchTokens, caseSensitive),
        };
      }
      return item;
    });
  }
}
