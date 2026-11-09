export class SearchEngine {
  constructor() {
    this.docs = [];
  }

  addDocument(doc) {
    // doc: { id, title, content, tags?: string[], updatedAt?: number }
    this.docs.push(doc);
  }

  search(query, options = {}) {
    return this.docs.filter(d => d.title.includes(query) || d.content.includes(query));
  }
}
