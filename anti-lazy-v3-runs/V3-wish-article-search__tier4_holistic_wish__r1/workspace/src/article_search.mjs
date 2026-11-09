const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in',
  'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the',
  'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with'
]);

/**
 * Normalize text: lowercase, strip diacritics, keep alphanumeric and CJK characters.
 */
function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Escape special regex characters to prevent regex syntax injection.
 */
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Tokenize text into words (Latin/numbers) and CJK characters/bigrams.
 */
function tokenize(text, { removeStopWords = false } = {}) {
  const norm = normalizeText(text);
  if (!norm) return [];

  const tokens = [];
  // Match Latin/numeric words or sequences of CJK characters
  const regex = /[a-z0-9]+(?:['_-][a-z0-9]+)*|[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g;
  let match;
  while ((match = regex.exec(norm)) !== null) {
    const chunk = match[0];
    if (/^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+$/.test(chunk)) {
      // Add full CJK chunk, unigrams, and bigrams for flexible CJK search
      tokens.push(chunk);
      if (chunk.length > 1) {
        for (let i = 0; i < chunk.length; i++) {
          tokens.push(chunk[i]);
          if (i < chunk.length - 1) {
            tokens.push(chunk.slice(i, i + 2));
          }
        }
      }
    } else {
      if (removeStopWords && STOP_WORDS.has(chunk)) continue;
      tokens.push(chunk);
      // Also split hyphenated/underscored words into sub-tokens
      if (chunk.includes('-') || chunk.includes('_')) {
        for (const sub of chunk.split(/[-_]+/)) {
          if (sub && (!removeStopWords || !STOP_WORDS.has(sub))) {
            tokens.push(sub);
          }
        }
      }
    }
  }
  return tokens;
}

/**
 * Simple English stemmer for better recall between singular/plural/verb forms.
 */
function stem(word) {
  if (!word || word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('es') && (word.endsWith('ches') || word.endsWith('shes') || word.endsWith('xes') || word.endsWith('ses') || word.endsWith('zes'))) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) {
    return word.slice(0, -1);
  }
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  return word;
}

/**
 * Damerau-Levenshtein edit distance (bounded) for typo tolerance / fuzzy matching.
 */
function editDistance(a, b, maxDist = 2) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDist) return maxDist + 1;

  const dp = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;

  for (let i = 1; i <= la; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, dp[i - 2][j - 2] + 1); // transposition
      }
      dp[i][j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return maxDist + 1;
  }
  return dp[la][lb];
}

/**
 * Parse query into structured tokens, phrases, exclusions, and tag filters.
 */
function parseQuery(rawQuery) {
  if (typeof rawQuery !== 'string') {
    return { phrases: [], terms: [], excludedTerms: [], requiredTags: [] };
  }

  let q = rawQuery.trim();
  const phrases = [];
  const excludedTerms = [];
  const requiredTags = [];

  // Extract quoted phrases: "exact phrase"
  q = q.replace(/"([^"]+)"/g, (_, phrase) => {
    const norm = normalizeText(phrase).trim();
    if (norm) phrases.push(norm);
    return ' ';
  });

  // Extract tag:value filters and -excluded terms
  const rawParts = q.split(/\s+/).filter(Boolean);
  const remainingParts = [];

  for (const part of rawParts) {
    if (part.startsWith('-') && part.length > 1) {
      const ex = normalizeText(part.slice(1));
      if (ex) excludedTerms.push(ex);
    } else if (/^tag:/i.test(part) && part.length > 4) {
      const t = normalizeText(part.slice(4));
      if (t) requiredTags.push(t);
    } else {
      remainingParts.push(part);
    }
  }

  const remainingText = remainingParts.join(' ');
  // Extract regular terms
  const termsWithoutStop = tokenize(remainingText, { removeStopWords: true });
  const allTerms = tokenize(remainingText, { removeStopWords: false });
  const terms = termsWithoutStop.length > 0 ? termsWithoutStop : allTerms;

  // Deduplicate terms while preserving order
  const uniqueTerms = [...new Set(terms)];

  return {
    phrases,
    terms: uniqueTerms,
    excludedTerms,
    requiredTags,
    normalizedFullQuery: normalizeText(remainingText || rawQuery).trim()
  };
}

/**
 * Count occurrences of a substring in text safely.
 */
function countSubstringOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

export class ArticleSearch {
  constructor(options = {}) {
    this.docs = [];
    this._index = new Map(); // id or doc ref -> indexed metadata
    this._df = new Map();    // term -> document frequency
    this._totalLength = 0;
    this.fieldWeights = {
      title: options.fieldWeights?.title ?? 4.0,
      tags: options.fieldWeights?.tags ?? 3.0,
      body: options.fieldWeights?.body ?? 1.0,
    };
  }

  /**
   * Add a document (or update if same non-null id already exists).
   * @param {object} doc - { id, title, body, tags?: string[] }
   */
  add(doc) {
    if (!doc || typeof doc !== 'object') {
      throw new TypeError('Document must be a valid object');
    }

    // Clone tags array to prevent external mutation issues
    const normalizedDoc = {
      ...doc,
      title: typeof doc.title === 'string' ? doc.title : String(doc.title ?? ''),
      body: typeof doc.body === 'string' ? doc.body : String(doc.body ?? ''),
      tags: Array.isArray(doc.tags) ? doc.tags.map(t => String(t)) : []
    };

    // If document with same id exists, remove old entry first
    if (normalizedDoc.id !== undefined && normalizedDoc.id !== null) {
      const existingIdx = this.docs.findIndex(d => d.id === normalizedDoc.id);
      if (existingIdx !== -1) {
        this._unindexDoc(this.docs[existingIdx]);
        this.docs.splice(existingIdx, 1);
      }
    }

    this.docs.push(normalizedDoc);
    this._indexDoc(normalizedDoc);
    return this;
  }

  /**
   * Add multiple documents at once.
   */
  addAll(docs) {
    if (!Array.isArray(docs)) return this;
    for (const doc of docs) {
      this.add(doc);
    }
    return this;
  }

  /**
   * Remove a document by id.
   */
  remove(id) {
    const idx = this.docs.findIndex(d => d.id === id);
    if (idx === -1) return false;
    const [removed] = this.docs.splice(idx, 1);
    this._unindexDoc(removed);
    return true;
  }

  /**
   * Clear all documents and index state.
   */
  clear() {
    this.docs = [];
    this._index.clear();
    this._df.clear();
    this._totalLength = 0;
  }

  _indexDoc(doc) {
    const normTitle = normalizeText(doc.title);
    const normBody = normalizeText(doc.body);
    const normTags = (doc.tags || []).map(t => normalizeText(t)).filter(Boolean);
    const normTagsText = normTags.join(' ');

    const titleTokens = tokenize(doc.title);
    const bodyTokens = tokenize(doc.body);
    const tagTokens = normTags.flatMap(t => tokenize(t));

    const countTokens = (tokens) => {
      const freq = new Map();
      const stemmedFreq = new Map();
      for (const t of tokens) {
        freq.set(t, (freq.get(t) || 0) + 1);
        const st = stem(t);
        stemmedFreq.set(st, (stemmedFreq.get(st) || 0) + 1);
      }
      return { freq, stemmedFreq, length: tokens.length };
    };

    const titleStats = countTokens(titleTokens);
    const bodyStats = countTokens(bodyTokens);
    const tagStats = countTokens(tagTokens);

    const allUniqueTerms = new Set([
      ...titleStats.freq.keys(),
      ...bodyStats.freq.keys(),
      ...tagStats.freq.keys(),
      ...titleStats.stemmedFreq.keys(),
      ...bodyStats.stemmedFreq.keys(),
      ...tagStats.stemmedFreq.keys()
    ]);

    for (const term of allUniqueTerms) {
      this._df.set(term, (this._df.get(term) || 0) + 1);
    }

    const docLength = titleStats.length + bodyStats.length + tagStats.length;
    this._totalLength += docLength;

    this._index.set(doc, {
      normTitle,
      normBody,
      normTags,
      normTagsText,
      titleStats,
      bodyStats,
      tagStats,
      allUniqueTerms,
      docLength
    });
  }

  _unindexDoc(doc) {
    const entry = this._index.get(doc);
    if (!entry) return;
    for (const term of entry.allUniqueTerms) {
      const prev = this._df.get(term) || 0;
      if (prev <= 1) this._df.delete(term);
      else this._df.set(term, prev - 1);
    }
    this._totalLength = Math.max(0, this._totalLength - entry.docLength);
    this._index.delete(doc);
  }

  /**
   * Compute BM25 + field-weighted + prefix/fuzzy relevance score for a single term against a doc.
   */
  _scoreTerm(term, entry, options) {
    const {
      fuzzy = true,
      prefix = true,
      maxEditDistance,
      fieldWeights
    } = options;

    const N = Math.max(1, this.docs.length);
    const avgdl = Math.max(1, this._totalLength / N);
    const k1 = 1.5;
    const b = 0.75;

    const stemmedTerm = stem(term);
    const df = Math.max(this._df.get(term) || 0, this._df.get(stemmedTerm) || 0);
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

    const scoreField = (stats, normText, weight) => {
      if (weight <= 0) return 0;

      // 1. Exact token match
      let tf = stats.freq.get(term) || 0;
      let matchQuality = 1.0;

      // 2. Stemmed token match
      if (tf === 0 && stemmedTerm !== term) {
        tf = stats.stemmedFreq.get(stemmedTerm) || 0;
        if (tf > 0) matchQuality = 0.85;
      }

      // 3. Prefix match on tokens
      if (tf === 0 && prefix && term.length >= 2) {
        for (const [tok, count] of stats.freq.entries()) {
          if (tok.startsWith(term)) {
            tf += count;
            // Closer length to prefix gets higher quality
            const ratio = Math.min(1, term.length / tok.length);
            matchQuality = Math.max(matchQuality === 1.0 ? 0 : matchQuality, 0.65 + 0.25 * ratio);
          }
        }
      }

      // 4. Substring match fallback (e.g. compound words or CJK substrings)
      if (tf === 0 && normText && normText.includes(term)) {
        tf = countSubstringOccurrences(normText, term);
        matchQuality = 0.55;
      }

      // 5. Fuzzy match (typo tolerance via Damerau-Levenshtein)
      if (tf === 0 && fuzzy && term.length >= 4) {
        const allowedDist = maxEditDistance ?? (term.length >= 7 ? 2 : 1);
        let bestDist = allowedDist + 1;
        let matchedCount = 0;

        for (const [tok, count] of stats.freq.entries()) {
          if (tok.length < 3) continue;
          const dist = editDistance(term, tok, allowedDist);
          if (dist <= allowedDist) {
            if (dist < bestDist) {
              bestDist = dist;
              matchedCount = count;
            } else if (dist === bestDist) {
              matchedCount += count;
            }
          }
        }

        if (bestDist <= allowedDist) {
          tf = matchedCount;
          matchQuality = bestDist === 1 ? 0.45 : 0.3;
        }
      }

      if (tf <= 0) return 0;

      const dl = Math.max(1, stats.length);
      const normTf = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgdl)));
      return idf * normTf * weight * matchQuality;
    };

    const titleScore = scoreField(entry.titleStats, entry.normTitle, fieldWeights.title);
    const tagsScore = scoreField(entry.tagStats, entry.normTagsText, fieldWeights.tags);
    const bodyScore = scoreField(entry.bodyStats, entry.normBody, fieldWeights.body);

    return titleScore + tagsScore + bodyScore;
  }

  /**
   * Generate highlighted text or snippet around matched terms.
   */
  _highlight(text, terms, phrases, highlightTag = 'mark') {
    if (!text) return '';
    const candidates = [...phrases, ...terms]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (candidates.length === 0) return text;

    const pattern = candidates.map(escapeRegExp).join('|');
    if (!pattern) return text;

    const regex = new RegExp(`(${pattern})`, 'gi');
    return text.replace(regex, `<${highlightTag}>$1</${highlightTag}>`);
  }

  /**
   * Search documents with relevance ranking, multi-term tokenization, title/tag weighting,
   * prefix & fuzzy matching, tag filtering, and optional pagination/highlighting.
   *
   * @param {string} query
   * @param {object} [options]
   * @param {string|string[]} [options.tags] - Filter by tag(s)
   * @param {'AND'|'OR'} [options.operator='OR'] - Multi-term boolean operator ('AND' or 'OR')
   * @param {boolean} [options.fuzzy=true] - Enable typo-tolerant fuzzy matching
   * @param {boolean} [options.prefix=true] - Enable prefix matching
   * @param {number} [options.maxEditDistance] - Max edit distance for fuzzy matching
   * @param {number} [options.minScore=0] - Minimum relevance score threshold
   * @param {number} [options.limit] - Maximum number of results to return
   * @param {number} [options.offset=0] - Number of results to skip
   * @param {string[]} [options.fields] - Fields to search in (['title', 'body', 'tags'])
   * @param {object} [options.boost] - Custom field weight overrides ({ title, tags, body })
   * @param {boolean} [options.includeScore=false] - Attach `_score` (and `score`) to result objects
   * @param {boolean} [options.highlight=false] - Attach `_highlights` with <mark> tags
   * @param {string} [options.highlightTag='mark'] - Custom HTML tag for highlights
   * @returns {Array<object>} Ranked array of matching documents
   */
  search(query, options = {}) {
    if (query === null || query === undefined) {
      return [];
    }

    const rawQueryStr = String(query);
    const trimmedQuery = rawQueryStr.trim();

    // Option normalization
    const {
      tags: filterTagsOption,
      tag: singleTagOption,
      operator = 'OR',
      fuzzy = true,
      prefix = true,
      maxEditDistance,
      minScore = 0,
      limit,
      offset = 0,
      fields,
      boost,
      includeScore = false,
      highlight = false,
      highlightTag = 'mark'
    } = options || {};

    // Resolve active field weights
    const activeFields = Array.isArray(fields) && fields.length > 0
      ? new Set(fields.map(f => String(f).toLowerCase()))
      : new Set(['title', 'body', 'tags']);

    const fieldWeights = {
      title: activeFields.has('title') ? (boost?.title ?? this.fieldWeights.title) : 0,
      tags: activeFields.has('tags') ? (boost?.tags ?? this.fieldWeights.tags) : 0,
      body: activeFields.has('body') ? (boost?.body ?? this.fieldWeights.body) : 0
    };

    const parsed = parseQuery(rawQueryStr);

    // Combine explicit tag filter options + query `tag:xxx` filters
    const requiredTags = [...parsed.requiredTags];
    if (typeof singleTagOption === 'string' && singleTagOption.trim()) {
      requiredTags.push(normalizeText(singleTagOption.trim()));
    }
    if (typeof filterTagsOption === 'string' && filterTagsOption.trim()) {
      requiredTags.push(normalizeText(filterTagsOption.trim()));
    } else if (Array.isArray(filterTagsOption)) {
      for (const t of filterTagsOption) {
        const nt = normalizeText(String(t));
        if (nt) requiredTags.push(nt);
      }
    }

    // If query is empty and no tag filters are given, return empty array
    if (!trimmedQuery && requiredTags.length === 0) {
      return [];
    }

    const scoredResults = [];
    const upperOp = String(operator).toUpperCase();

    for (let idx = 0; idx < this.docs.length; idx++) {
      const doc = this.docs[idx];
      // Ensure doc is indexed (in case this.docs was mutated directly)
      let entry = this._index.get(doc);
      if (!entry) {
        this._indexDoc(doc);
        entry = this._index.get(doc);
      }

      // 1. Check required tags filter
      if (requiredTags.length > 0) {
        const hasAllTags = requiredTags.every(reqTag =>
          entry.normTags.some(docTag => docTag === reqTag || docTag.includes(reqTag))
        );
        if (!hasAllTags) continue;
      }

      // 2. Check excluded terms (-term)
      if (parsed.excludedTerms.length > 0) {
        const hasExcluded = parsed.excludedTerms.some(ex =>
          (fieldWeights.title > 0 && (entry.titleStats.freq.has(ex) || entry.normTitle.includes(ex))) ||
          (fieldWeights.body > 0 && (entry.bodyStats.freq.has(ex) || entry.normBody.includes(ex))) ||
          (fieldWeights.tags > 0 && (entry.tagStats.freq.has(ex) || entry.normTagsText.includes(ex)))
        );
        if (hasExcluded) continue;
      }

      // 3. Check exact quoted phrases ("...")
      let phraseBonus = 0;
      let allPhrasesMatched = true;
      for (const phrase of parsed.phrases) {
        const inTitle = fieldWeights.title > 0 && entry.normTitle.includes(phrase);
        const inTags = fieldWeights.tags > 0 && entry.normTagsText.includes(phrase);
        const inBody = fieldWeights.body > 0 && entry.normBody.includes(phrase);
        if (!inTitle && !inTags && !inBody) {
          allPhrasesMatched = false;
          break;
        }
        if (inTitle) phraseBonus += fieldWeights.title * 3.0;
        if (inTags) phraseBonus += fieldWeights.tags * 2.5;
        if (inBody) phraseBonus += fieldWeights.body * 1.5;
      }
      if (!allPhrasesMatched) continue;

      // If only tag filters or excluded terms were provided with no search terms/phrases
      if (parsed.terms.length === 0 && parsed.phrases.length === 0) {
        scoredResults.push({ doc, score: 1.0 + phraseBonus, idx });
        continue;
      }

      // 4. Score individual query terms
      let totalTermScore = 0;
      let matchedTermCount = 0;

      for (const term of parsed.terms) {
        const termScore = this._scoreTerm(term, entry, {
          fuzzy,
          prefix,
          maxEditDistance,
          fieldWeights
        });
        if (termScore > 0) {
          matchedTermCount++;
          totalTermScore += termScore;
        }
      }

      // Enforce boolean operator
      if (parsed.terms.length > 0) {
        if (upperOp === 'AND' && matchedTermCount < parsed.terms.length) {
          continue;
        }
        if (matchedTermCount === 0 && parsed.phrases.length === 0) {
          continue;
        }
      }

      // 5. Coverage / coordination bonus (matching more query terms ranks significantly higher)
      let score = totalTermScore + phraseBonus;
      if (parsed.terms.length > 1 && matchedTermCount > 0) {
        const coverageRatio = matchedTermCount / parsed.terms.length;
        // Boost documents that match all or most query terms
        score *= (1 + coverageRatio * 0.75);
        if (matchedTermCount === parsed.terms.length) {
          score *= 1.35; // Full term coverage bonus
        }
      }

      // 6. Exact full-query phrase boost in title / tags / body
      const fullQuery = parsed.normalizedFullQuery;
      if (fullQuery && fullQuery.length > 1) {
        if (fieldWeights.title > 0 && entry.normTitle === fullQuery) {
          score += fieldWeights.title * 5.0;
        } else if (fieldWeights.title > 0 && entry.normTitle.includes(fullQuery)) {
          score += fieldWeights.title * 2.5;
        }
        if (fieldWeights.tags > 0 && entry.normTags.includes(fullQuery)) {
          score += fieldWeights.tags * 3.0;
        }
        if (fieldWeights.body > 0 && entry.normBody.includes(fullQuery)) {
          score += fieldWeights.body * 1.2;
        }
      }

      if (score >= minScore && score > 0) {
        scoredResults.push({ doc, score, idx });
      }
    }

    // Sort by descending relevance score, then preserve insertion order for ties
    scoredResults.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 1e-9) {
        return b.score - a.score;
      }
      return a.idx - b.idx;
    });

    // Apply offset and limit
    const start = Math.max(0, Number(offset) || 0);
    const end = limit !== undefined && limit !== null
      ? start + Math.max(0, Number(limit))
      : undefined;
    const sliced = scoredResults.slice(start, end);

    // Format output (preserve original doc object structure unless metadata is requested)
    return sliced.map(({ doc, score }) => {
      if (!includeScore && !highlight) {
        return doc;
      }
      const result = { ...doc };
      if (includeScore) {
        result.score = Number(score.toFixed(6));
        result._score = result.score;
      }
      if (highlight) {
        result._highlights = {
          title: this._highlight(doc.title, parsed.terms, parsed.phrases, highlightTag),
          body: this._highlight(doc.body, parsed.terms, parsed.phrases, highlightTag)
        };
      }
      return result;
    });
  }
}

export default ArticleSearch;
