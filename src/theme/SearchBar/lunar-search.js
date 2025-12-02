/*
Aloglia DocSearch Adapter for Lunr.js
====================================
Written by:  Praveen N
github: praveenn77
*/

import lunr from "@generated/lunr.client";
lunr.tokenizer.separator = /[\s\-/]+/;

class LunrSearchAdapter {
    constructor(searchDocs, searchIndex, baseUrl = '/', maxHits) {
        this.searchDocs = searchDocs;
        this.lunrIndex = lunr.Index.load(searchIndex);
        this.baseUrl = baseUrl;
        this.maxHits = maxHits;
    }

    getLunrResult(input) {
        // Parse input to extract quoted phrases and individual terms
        const phrases = [];
        const terms = [];
        
        // Match quoted phrases (e.g., "red pepper" or 'red pepper')
        const phraseRegex = /(["'])((?:(?=(\\?))\3.)*?)\1/g;
        let match;
        let lastIndex = 0;
        
        while ((match = phraseRegex.exec(input)) !== null) {
            // Add text before the phrase as individual terms
            const beforePhrase = input.substring(lastIndex, match.index).trim();
            if (beforePhrase) {
                const beforeTokens = lunr.tokenizer(beforePhrase);
                beforeTokens.forEach(token => terms.push(token));
            }
            
            // Extract the phrase content (without quotes)
            const phraseContent = match[2];
            phrases.push(phraseContent);
            
            lastIndex = phraseRegex.lastIndex;
        }
        
        // Add remaining text after last phrase as individual terms
        const remaining = input.substring(lastIndex).trim();
        if (remaining) {
            const remainingTokens = lunr.tokenizer(remaining);
            remainingTokens.forEach(token => terms.push(token));
        }
        
        // If no phrases were found, treat entire input as terms (backward compatibility)
        if (phrases.length === 0 && terms.length === 0) {
            const tokens = lunr.tokenizer(input);
            tokens.forEach(token => terms.push(token));
        }
        
        // Store phrases for filtering (convert to lowercase for case-insensitive matching)
        this._phrases = phrases.map(p => p.toLowerCase());
        
        // Build query - search for all tokens (from phrases and individual terms)
        const allTokens = [];
        phrases.forEach(phrase => {
            const phraseTokens = lunr.tokenizer(phrase);
            phraseTokens.forEach(token => allTokens.push(token));
        });
        terms.forEach(token => allTokens.push(token));
        
        return this.lunrIndex.query(function (query) {
            // Add all tokens with boost
            if (allTokens.length > 0) {
                query.term(allTokens, {
                    boost: 10
                });
                query.term(allTokens, {
                    wildcard: lunr.Query.wildcard.TRAILING
                });
            }
        });
    }
    
    // Check if a document contains a phrase (tokens in sequence)
    _containsPhrase(doc, phrase) {
        const phraseLower = phrase.toLowerCase();
        const contentLower = (doc.content || '').toLowerCase();
        const titleLower = (doc.title || '').toLowerCase();
        const keywordsLower = (doc.keywords || '').toLowerCase();
        
        // Check if phrase appears in content, title, or keywords
        return contentLower.includes(phraseLower) || 
               titleLower.includes(phraseLower) || 
               keywordsLower.includes(phraseLower);
    }

    getHit(doc, formattedTitle, formattedContent) {
        return {
            hierarchy: {
                lvl0: doc.pageTitle || doc.title,
                lvl1: doc.type === 0 ? null : doc.title
            },
            url: doc.url,
            version: doc.version,
            _snippetResult: formattedContent ? {
                content: {
                    value: formattedContent,
                    matchLevel: "full"
                }
            } : null,
            _highlightResult: {
                hierarchy: {
                    lvl0: {
                        value: doc.type === 0 ? formattedTitle || doc.title : doc.pageTitle,
                    },
                    lvl1:
                        doc.type === 0
                            ? null
                            : {
                                value: formattedTitle || doc.title
                            }
                }
            }
        };
    }
    getTitleHit(doc, position, length) {
        const start = position[0];
        const end = position[0] + length;
        let formattedTitle = doc.title.substring(0, start) + '<span class="algolia-docsearch-suggestion--highlight">' + doc.title.substring(start, end) + '</span>' + doc.title.substring(end, doc.title.length);
        return this.getHit(doc, formattedTitle)
    }

    getKeywordHit(doc, position, length) {
        const start = position[0];
        const end = position[0] + length;
        let formattedTitle = doc.title + '<br /><i>Keywords: ' + doc.keywords.substring(0, start) + '<span class="algolia-docsearch-suggestion--highlight">' + doc.keywords.substring(start, end) + '</span>' + doc.keywords.substring(end, doc.keywords.length) + '</i>'
        return this.getHit(doc, formattedTitle)
    }

    getContentHit(doc, position) {
        const start = position[0];
        const end = position[0] + position[1];
        let previewStart = start;
        let previewEnd = end;
        let ellipsesBefore = true;
        let ellipsesAfter = true;
        for (let k = 0; k < 3; k++) {
            const nextSpace = doc.content.lastIndexOf(' ', previewStart - 2);
            const nextDot = doc.content.lastIndexOf('.', previewStart - 2);
            if ((nextDot > 0) && (nextDot > nextSpace)) {
                previewStart = nextDot + 1;
                ellipsesBefore = false;
                break;
            }
            if (nextSpace < 0) {
                previewStart = 0;
                ellipsesBefore = false;
                break;
            }
            previewStart = nextSpace + 1;
        }
        for (let k = 0; k < 10; k++) {
            const nextSpace = doc.content.indexOf(' ', previewEnd + 1);
            const nextDot = doc.content.indexOf('.', previewEnd + 1);
            if ((nextDot > 0) && (nextDot < nextSpace)) {
                previewEnd = nextDot;
                ellipsesAfter = false;
                break;
            }
            if (nextSpace < 0) {
                previewEnd = doc.content.length;
                ellipsesAfter = false;
                break;
            }
            previewEnd = nextSpace;
        }
        let preview = doc.content.substring(previewStart, start);
        if (ellipsesBefore) {
            preview = '... ' + preview;
        }
        preview += '<span class="algolia-docsearch-suggestion--highlight">' + doc.content.substring(start, end) + '</span>';
        preview += doc.content.substring(end, previewEnd);
        if (ellipsesAfter) {
            preview += ' ...';
        }
        return this.getHit(doc, null, preview);

    }
    search(input) {
        return new Promise((resolve, rej) => {
            const results = this.getLunrResult(input);
            const hits = [];
            this.titleHitsRes = []
            this.contentHitsRes = []
            
            // Filter results: if we have phrases, only include docs that contain at least one phrase
            const filteredResults = results.filter(result => {
                const doc = this.searchDocs[result.ref];
                // If no phrases specified, include all results
                if (!this._phrases || this._phrases.length === 0) {
                    return true;
                }
                // Check if document contains any of the phrases
                return this._phrases.some(phrase => this._containsPhrase(doc, phrase));
            });
            
            filteredResults.length > this.maxHits && (filteredResults.length = this.maxHits);
            
            filteredResults.forEach(result => {
                const doc = this.searchDocs[result.ref];
                const { metadata } = result.matchData;
                for (let i in metadata) {
                    if (metadata[i].title) {
                        if (!this.titleHitsRes.includes(result.ref)) {
                            const position = metadata[i].title.position[0]
                            hits.push(this.getTitleHit(doc, position, input.length));
                            this.titleHitsRes.push(result.ref);
                        }
                    } else if (metadata[i].content) {
                        const position = metadata[i].content.position[0]
                        hits.push(this.getContentHit(doc, position))
                    } else if (metadata[i].keywords) {
                        const position = metadata[i].keywords.position[0]
                        hits.push(this.getKeywordHit(doc, position, input.length));
                        this.titleHitsRes.push(result.ref);
                    }
                }
            });
            hits.length > this.maxHits && (hits.length = this.maxHits);
            resolve(hits);
        });
    }
}

export default LunrSearchAdapter;
