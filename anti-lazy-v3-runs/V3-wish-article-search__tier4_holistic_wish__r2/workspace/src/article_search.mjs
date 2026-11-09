/**
 * Escape special regular expression characters to prevent regex syntax injection.
 */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize text: lowercase, strip diacritics where appropriate, trim.
 */
function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Tokenize text into words (supports Latin/alphanumeric words and CJK characters/bigrams).
 */
function tokenize(text) {
  const norm = normalizeText(text);
  if (!norm) return [];
  const tokens = [];
  // Match alphanumeric/underscore words or individual CJK characters
  const wordRegex = /[a-z0-9_]+|[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
  let match;
  while ((match = wordRegex.exec(norm)) !== null) {
    tokens.push(match[0]);
  }
  return tokens;
}

/**
 * Split query into search terms and quoted phrases, supporting -exclude and tag: filters.
 */
function parseQuery(rawQuery) {
  if (typeof rawQuery !== 'string') {
    return { phrases: [], terms: [], excluded: [], inlineTags: [] };
  }
  const phrases = [];
  const terms = [];
  const excluded = [];
  const inlineTags = [];

  // Extract quoted phrases first
  const working = rawQuery.replace(/"([^"]+)"/g, (_, phrase) => {
    const clean = normalizeText(phrase).trim();
    if (clean) phrases.push(clean);
    return ' ';
  });

  const parts = working.trim().split(/\s+/).filter(Boolean);
  for (const part of parts) {
    if (part.startsWith('-') && part.length > 1) {
      const ex = normalizeText(part.slice(1)).trim();
      if (ex) excluded.push(ex);
    } else if (/^tag:/i.test(part) && part.length > 4) {
      const t = normalizeText(part.slice(4)).trim();
      if (t) inlineTags.push(t);
    } else {
      const subTokens = tokenize(part);
      // Keep contiguous CJK term as well if original part had CJK
      const normPart = normalizeText(part);
      if (/[\u4e00-\u9fff]/.test(normPart) && normPart.length > 1) {
        terms.push(normPart);
      } else {
        terms.push(...subTokens);
      }
    }
  }

  return { phrases, terms, excluded, inlineTags };
}

/**
 * Compute bounded Damerau-Levenshtein (optimal string alignment) distance for fuzzy matching.
 */
function editDistance(a, b, maxDistance = 2) {
  if (a === b) return 0;
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > maxDistance) return maxDistance + 1;
  if (lenA === 0) return lenB;
  if (lenB === 0) return lenA;

  const dp = Array.from({ length: lenA + 1 }, () => new Int32Array(lenB + 1));
  for (let i = 0; i <= lenA; i++) dp[i][0] = i;
  for (let j = 0; j <= lenB; j++) dp[0][j] = j;

  for (let i = 1; i <= lenA; i++) {
    let rowMin = maxDistance + 1;
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        val = Math.min(val, dp[i - 2][j - 2] + 1); // transposition
      }
      dp[i][j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
  }

  return dp[lenA][lenB];
}

/**
 * Deep clone a document cleanly without prototype pollution.
 */
function cloneDoc(doc) {
  const copy = Object.assign({}, doc);
  if (Array.isArray(doc.tags)) {
    copy.tags = [...doc.tags];
  }
  return copy;
}

export class ArticleSearch {
  constructor(options = {}) {
    this.docs = [];
    this._byId = new Map();
    this._indexed = [];
    this.weights = Object.assign(
      { title: 3.5, tags: 2.5, body: 1.0 },
      options.weights || {}
    );
  }

  /**
   * Add or update a document in the index.
   * doc: { id, title, body, tags?: string[], ... }
   */
  add(doc) {
    if (!doc || typeof doc !== 'object') {
      throw new TypeError('Document must be a non-null object');
    }

    const safeDoc = cloneDoc(doc);
    safeDoc.title = typeof safeDoc.title === 'string' ? safeDoc.title : String(safeDoc.title ?? '');
    safeDoc.body = typeof safeDoc.body === 'string' ? safeDoc.body : String(safeDoc.body ?? '');
    safeDoc.tags = Array.isArray(safeDoc.tags)
      ? safeDoc.tags.map(t => String(t))
      : [];

    const indexEntry = this._buildIndexEntry(safeDoc);

    if (safeDoc.id !== undefined && safeDoc.id !== null && this._byId.has(safeDoc.id)) {
      const existingIdx = this._byId.get(safeDoc.id);
      this.docs[existingIdx] = safeDoc;
      this._indexed[existingIdx] = indexEntry;
    } else {
      const idx = this.docs.length;
      if (safeDoc.id !== undefined && safeDoc.id !== null) {
        this._byId.set(safeDoc.id, idx);
      }
      this.docs.push(safeDoc);
      this._indexed.push(indexEntry);
    }

    return safeDoc;
  }

  /**
   * Add multiple documents at once.
   */
  addAll(docs) {
    if (!Array.isArray(docs)) return [];
    return docs.map(d => this.add(d));
  }

  /**
   * Remove a document by id.
   */
  remove(id) {
    if (!this._byId.has(id)) return false;
    const idx = this._byId.get(id);
    this.docs.splice(idx, 1);
    this._indexed.splice(idx, 1);
    this._byId.delete(id);
    // Rebuild index positions
    this._byId.clear();
    for (let i = 0; i < this.docs.length; i++) {
      const d = this.docs[i];
      if (d.id !== undefined && d.id !== null) {
        this._byId.set(d.id, i);
      }
    }
    return true;
  }

  /**
   * Clear all documents.
   */
  clear() {
    this.docs = [];
    this._indexed = [];
    this._byId.clear();
  }

  _buildIndexEntry(doc) {
    const titleNorm = normalizeText(doc.title);
    const bodyNorm = normalizeText(doc.body);
    const tagsNorm = doc.tags.map(t => normalizeText(t));

    const titleTokens = tokenize(doc.title);
    const bodyTokens = tokenize(doc.body);
    const tagTokens = doc.tags.flatMap(t => tokenize(t));

    const titleFreq = new Map();
    for (const t of titleTokens) titleFreq.set(t, (titleFreq.get(t) || 0) + 1);

    const bodyFreq = new Map();
    for (const t of bodyTokens) bodyFreq.set(t, (bodyFreq.get(t) || 0) + 1);

    const tagFreq = new Map();
    for (const t of tagTokens) tagFreq.set(t, (tagFreq.get(t) || 0) + 1);

    return {
      doc,
      titleNorm,
      bodyNorm,
      tagsNorm,
      titleTokens,
      bodyTokens,
      tagTokens,
      titleFreq,
      bodyFreq,
      tagFreq
    };
  }

  /**
   * Search documents with multi-term tokenization, field-weighted BM25/TF-IDF-inspired
   * relevance scoring, prefix & fuzzy matching, tag filtering, pagination, and highlighting.
   *
   * @param {string} query
   * @param {object} [options]
   * @param {string|string[]} [options.tags] - Filter documents containing all specified tags (or any if tagMode='any')
   * @param {'all'|'any'} [options.tagMode='all'] - Tag filter mode
   * @param {'or'|'and'} [options.operator='or'] - Whether all query terms must match ('and') or any ('or', with boost for matching more terms)
   * @param {boolean} [options.fuzzy=true] - Allow typo-tolerant fuzzy matching
   * @param {number} [options.maxEditDistance] - Max edit distance for fuzzy matching (defaults to 1 for length 4-5, 2 for >=6)
   * @param {boolean} [options.prefix=true] - Allow prefix matching
   * @param {number} [options.limit] - Maximum number of results to return
   * @param {number} [options.offset=0] - Number of results to skip
   * @param {number} [options.minScore=0] - Minimum relevance score threshold
   * @param {boolean} [options.includeScore=false] - Attach `_score` (and `score`) to returned items
   * @param {boolean} [options.highlight=false] - Attach `_highlights` with matched snippets
   * @param {string} [options.highlightTag='mark'] - HTML tag name for highlights
   * @param {string[]} [options.fields=['title','body','tags']] - Fields to search in
   * @param {Function} [options.filter] - Custom predicate `fn(doc) => boolean`
   */
  search(query, options = {}) {
    const {
      tags: filterTags,
      tagMode = 'all',
      operator = 'or',
      fuzzy = true,
      maxEditDistance,
      prefix = true,
      limit,
      offset = 0,
      minScore = 0,
      includeScore = false,
      highlight = false,
      highlightTag = 'mark',
      fields = ['title', 'body', 'tags'],
      filter
    } = options || {};

    const activeFields = new Set(Array.isArray(fields) ? fields : ['title', 'body', 'tags']);
    const parsed = parseQuery(query);
    const rawNorm = normalizeText(typeof query === 'string' ? query.trim() : '');

    // Combine explicit options.tags with inline `tag:xyz` filters
    const requiredTags = [];
    if (filterTags) {
      const list = Array.isArray(filterTags) ? filterTags : [filterTags];
      for (const t of list) {
        const nt = normalizeText(String(t)).trim();
        if (nt) requiredTags.push(nt);
      }
    }
    for (const t of parsed.inlineTags) {
      requiredTags.push(t);
    }

    const hasQueryTerms =
      parsed.terms.length > 0 ||
      parsed.phrases.length > 0 ||
      rawNorm.length > 0;

    // Precompute IDF for query terms across corpus
    const N = Math.max(1, this._indexed.length);
    const idfMap = new Map();
    for (const term of parsed.terms) {
      let df = 0;
      for (const entry of this._indexed) {
        if (
          entry.titleFreq.has(term) ||
          entry.bodyFreq.has(term) ||
          entry.tagFreq.has(term) ||
          entry.titleNorm.includes(term) ||
          entry.bodyNorm.includes(term)
        ) {
          df++;
        }
      }
      // Smooth BM25-style IDF
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5)) + 1;
      idfMap.set(term, idf);
    }

    const scoredResults = [];

    for (let idx = 0; idx < this._indexed.length; idx++) {
      const entry = this._indexed[idx];
      const { doc } = entry;

      // 1. Custom filter predicate
      if (typeof filter === 'function' && !filter(doc)) {
        continue;
      }

      // 2. Tag filtering
      if (requiredTags.length > 0) {
        const docTags = entry.tagsNorm;
        if (tagMode === 'any') {
          const hasAny = requiredTags.some(rt =>
            docTags.some(dt => dt === rt || dt.includes(rt))
          );
          if (!hasAny) continue;
        } else {
          const hasAll = requiredTags.every(rt =>
            docTags.some(dt => dt === rt || dt.includes(rt))
          );
          if (!hasAll) continue;
        }
      }

      // 3. Excluded terms (-term)
      if (parsed.excluded.length > 0) {
        const isExcluded = parsed.excluded.some(
          ex =>
            (activeFields.has('title') && entry.titleNorm.includes(ex)) ||
            (activeFields.has('body') && entry.bodyNorm.includes(ex)) ||
            (activeFields.has('tags') && entry.tagsNorm.some(t => t.includes(ex)))
        );
        if (isExcluded) continue;
      }

      // If query is empty or only contained tag/exclude filters, return matching docs
      if (!hasQueryTerms || (parsed.terms.length === 0 && parsed.phrases.length === 0)) {
        if (rawNorm === '' || parsed.inlineTags.length > 0 || parsed.excluded.length > 0) {
          scoredResults.push({ entry, score: 1, matchedTerms: [], idx });
          continue;
        }
      }

      let totalScore = 0;
      let matchedTermCount = 0;
      const matchedLiterals = new Set();

      // 4. Exact phrase requirements ("quoted phrase")
      let phrasesMatched = true;
      for (const phrase of parsed.phrases) {
        let phraseScore = 0;
        if (activeFields.has('title') && entry.titleNorm.includes(phrase)) {
          phraseScore += 6.0 * this.weights.title;
          matchedLiterals.add(phrase);
        }
        if (activeFields.has('tags') && entry.tagsNorm.some(t => t.includes(phrase))) {
          phraseScore += 4.5 * this.weights.tags;
          matchedLiterals.add(phrase);
        }
        if (activeFields.has('body') && entry.bodyNorm.includes(phrase)) {
          phraseScore += 3.0 * this.weights.body;
          matchedLiterals.add(phrase);
        }
        if (phraseScore === 0) {
          phrasesMatched = false;
          break;
        }
        totalScore += phraseScore;
      }
      if (!phrasesMatched) continue;

      // 5. Full query exact / substring boost
      if (rawNorm && parsed.phrases.length === 0 && parsed.excluded.length === 0 && parsed.inlineTags.length === 0) {
        if (activeFields.has('title')) {
          if (entry.titleNorm === rawNorm) {
            totalScore += 15.0 * this.weights.title;
            matchedLiterals.add(rawNorm);
          } else if (entry.titleNorm.includes(rawNorm)) {
            totalScore += 5.0 * this.weights.title;
            matchedLiterals.add(rawNorm);
          }
        }
        if (activeFields.has('tags')) {
          if (entry.tagsNorm.some(t => t === rawNorm)) {
            totalScore += 10.0 * this.weights.tags;
            matchedLiterals.add(rawNorm);
          } else if (entry.tagsNorm.some(t => t.includes(rawNorm))) {
            totalScore += 4.0 * this.weights.tags;
            matchedLiterals.add(rawNorm);
          }
        }
        if (activeFields.has('body') && entry.bodyNorm.includes(rawNorm)) {
          totalScore += 2.5 * this.weights.body;
          matchedLiterals.add(rawNorm);
        }
      }

      // 6. Per-term scoring across fields (Exact token -> Prefix -> Substring -> Fuzzy)
      for (const term of parsed.terms) {
        const idf = idfMap.get(term) || 1.0;
        let termScore = 0;

        if (activeFields.has('title')) {
          const s = this._scoreField(
            term,
            entry.titleFreq,
            entry.titleTokens,
            entry.titleNorm,
            { prefix, fuzzy, maxEditDistance },
            matchedLiterals
          );
          termScore += s * this.weights.title;
        }

        if (activeFields.has('tags')) {
          const s = this._scoreField(
            term,
            entry.tagFreq,
            entry.tagTokens,
            entry.tagsNorm.join(' '),
            { prefix, fuzzy, maxEditDistance },
            matchedLiterals
          );
          termScore += s * this.weights.tags;
        }

        if (activeFields.has('body')) {
          const s = this._scoreField(
            term,
            entry.bodyFreq,
            entry.bodyTokens,
            entry.bodyNorm,
            { prefix, fuzzy, maxEditDistance },
            matchedLiterals
          );
          termScore += s * this.weights.body;
        }

        if (termScore > 0) {
          matchedTermCount++;
          totalScore += termScore * idf;
        }
      }

      // Check operator condition
      if (parsed.terms.length > 0) {
        if (operator.toLowerCase() === 'and' && matchedTermCount < parsed.terms.length) {
          continue;
        }
        if (matchedTermCount === 0 && totalScore === 0) {
          continue;
        }
        // Coordination factor: strongly reward documents matching more of the query terms
        const coverage = matchedTermCount / parsed.terms.length;
        totalScore *= 0.5 + 0.5 * coverage;
        if (matchedTermCount === parsed.terms.length && parsed.terms.length > 1) {
          totalScore *= 1.35;
        }
      }

      if (totalScore <= 0 || totalScore < minScore) {
        continue;
      }

      scoredResults.push({
        entry,
        score: Number(totalScore.toFixed(6)),
        matchedTerms: Array.from(matchedLiterals),
        idx
      });
    }

    // Sort by descending relevance score, breaking ties by insertion order
    scoredResults.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx;
    });

    const start = Math.max(0, Number(offset) || 0);
    const end =
      limit !== undefined && limit !== null
        ? start + Math.max(0, Number(limit))
        : scoredResults.length;

    const sliced = scoredResults.slice(start, end);

    return sliced.map(({ entry, score, matchedTerms }) => {
      if (!includeScore && !highlight) {
        return cloneDoc(entry.doc);
      }
      const out = cloneDoc(entry.doc);
      if (includeScore) {
        out._score = score;
        if (out.score === undefined) out.score = score;
      }
      if (highlight) {
        out._highlights = {
          title: this._highlightText(entry.doc.title, matchedTerms, highlightTag),
          body: this._highlightText(entry.doc.body, matchedTerms, highlightTag)
        };
      }
      return out;
    });
  }

  _scoreField(term, freqMap, tokens, rawNormText, { prefix, fuzzy, maxEditDistance }, matchedLiterals) {
    let score = 0;

    // 1. Exact token match (with saturating TF)
    const exactCount = freqMap.get(term) || 0;
    if (exactCount > 0) {
      // BM25-like TF saturation: tf / (tf + 1.2)
      score += 3.0 * ((exactCount * 2.2) / (exactCount + 1.2));
      matchedLiterals.add(term);
      return score;
    }

    // 2. Prefix match on tokens
    if (prefix && term.length >= 2) {
      let prefixMatches = 0;
      for (const tok of tokens) {
        if (tok.length > term.length && tok.startsWith(term)) {
          prefixMatches++;
          matchedLiterals.add(tok);
        }
      }
      if (prefixMatches > 0) {
        score += 2.0 * ((prefixMatches * 1.8) / (prefixMatches + 1.2));
        return score;
      }
    }

    // 3. Substring match (especially useful for CJK or compound words)
    if (rawNormText && rawNormText.includes(term)) {
      score += 1.6;
      matchedLiterals.add(term);
      return score;
    }

    // 4. Fuzzy match (typo tolerance via Damerau-Levenshtein distance)
    const allowedDist =
      maxEditDistance !== undefined
        ? maxEditDistance
        : term.length >= 6
          ? 2
          : term.length >= 4
            ? 1
            : 0;

    if (fuzzy && allowedDist > 0 && tokens.length > 0) {
      let bestDist = allowedDist + 1;
      let bestToken = null;
      for (const tok of tokens) {
        if (Math.abs(tok.length - term.length) > allowedDist) continue;
        // Require same first character or length >= 5 to avoid noisy false positives
        if (tok[0] !== term[0] && term.length < 5) continue;
        const dist = editDistance(term, tok, allowedDist);
        if (dist <= allowedDist && dist < bestDist) {
          bestDist = dist;
          bestToken = tok;
          if (dist === 1) break;
        }
      }
      if (bestDist <= allowedDist && bestToken) {
        const penalty = bestDist === 1 ? 0.55 : 0.3;
        score += 2.0 * penalty;
        matchedLiterals.add(bestToken);
      }
    }

    return score;
  }

  _highlightText(text, matchedTerms, tag = 'mark') {
    if (!text || !matchedTerms || matchedTerms.length === 0) return text || '';
    const unique = Array.from(new Set(matchedTerms.filter(Boolean))).sort(
      (a, b) => b.length - a.length
    );
    if (unique.length === 0) return text;
    const pattern = unique.map(escapeRegex).join('|');
    if (!pattern) return text;
    const regex = new RegExp(`(${pattern})`, 'gi');
    return text.replace(regex, `<${tag}>$1</${tag}>`);
  }
}
