import { normalize } from './alignment.js';

// Ignore vowel length variations when locating a passage, not when grading it.
const simplify = text => normalize(text).replace(/[\u064b-\u0652]/gu, '').replace(/(.)\1+/gu, '$1');
const MAX_QUERY_LENGTH = 180;
let passages = [];
const grams = text => new Set(Array.from({ length: Math.max(0, text.length - 2) }, (_, i) => text.slice(i, i + 3)));
const positionAt = (passage, offset) => passage.positions.findLast(item => item.offset <= offset);
function retainMatch(matches, position, score) {
  const previous = matches.get(position.key);
  if (!previous || score > previous.score || score === previous.score && position.word < previous.word)
    matches.set(position.key, { key: position.key, word: position.word, score });
}

// Semi-global edit distance: the recitation may begin anywhere inside an ayah.
function locate(query, passage) {
  const { text } = passage;
  let previous = new Uint16Array(text.length + 1), starts = Uint32Array.from({ length: text.length + 1 }, (_, i) => i);
  for (let i = 1; i <= query.length; i++) {
    const row = new Uint16Array(text.length + 1), nextStarts = new Uint32Array(text.length + 1);
    row[0] = i;
    for (let j = 1; j <= text.length; j++) {
      const diagonal = previous[j - 1] + (query[i - 1] === text[j - 1] ? 0 : 1);
      const deletion = previous[j] + 1, insertion = row[j - 1] + 1;
      row[j] = Math.min(diagonal, deletion, insertion);
      nextStarts[j] = row[j] === diagonal ? starts[j - 1] : row[j] === deletion ? starts[j] : nextStarts[j - 1];
    }
    previous = row; starts = nextStarts;
  }
  const matches = new Map();
  // Every qualifying ending can identify a different starting ayah. Keeping
  // only the single best ending could conceal similar neighboring verses.
  for (let end = 1; end <= text.length; end++) {
    const score = 1 - previous[end] / query.length;
    if (score < .62) continue;
    const position = positionAt(passage, starts[end]);
    if (position) retainMatch(matches, position, score);
  }
  return [...matches.values()];
}

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      passages = data.verses.map((verse, i) => {
        let text = '', firstAyahEnd = 0; const positions = [];
        // Include enough following text for a full query beginning anywhere
        // in this ayah, including phrases crossing several very short ayahs.
        for (let partIndex = i; partIndex < data.verses.length; partIndex++) {
          const part = data.verses[partIndex];
          if (part.key.split(':')[0] !== verse.key.split(':')[0]) break;
          part.phonemes.forEach((phoneme, word) => {
            positions.push({ offset: text.length, key: part.key, word }); text += simplify(phoneme);
          });
          if (partIndex === i) firstAyahEnd = text.length;
          if (text.length - firstAyahEnd >= MAX_QUERY_LENGTH) break;
        }
        return { text, positions, grams: grams(text) };
      });
      return;
    }
    const simplified = simplify(data.text), query = simplified.slice(-MAX_QUERY_LENGTH), queryGrams = grams(query);
    const metadata = { queryLength: query.length, queryTruncated: simplified.length > query.length };
    if (query.length < 12) { postMessage({ id: data.id, results: [], short: true, autoOpenEligible: false, candidateCount: 0, ...metadata }); return; }
    const matches = new Map();
    // Neighboring windows overlap, and repeated phrases can occur far beyond
    // the fuzzy shortlist. Find every exact location before deciding whether
    // a phrase is unique; never hide repeats behind a top-five result limit.
    const exactLocations = new Set();
    for (const p of passages) {
      let offset = p.text.indexOf(query);
      while (offset !== -1) {
        const position = positionAt(p, offset);
        if (position) {
          exactLocations.add(position.key);
          retainMatch(matches, position, 1);
        }
        offset = p.text.indexOf(query, offset + 1);
      }
    }
    const ranked = passages.map(p => ({ p, overlap: [...queryGrams].reduce((n, gram) => n + Number(p.grams.has(gram)), 0) }))
      .sort((a, b) => b.overlap - a.overlap);
    for (const candidate of ranked.slice(0, 80)) {
      const { p, overlap } = candidate;
      if (!overlap) continue;
      candidate.evaluated = true;
      for (const match of locate(query, p)) retainMatch(matches, match, match.score);
    }
    const results = [...matches.values()].sort((a, b) => b.score - a.score);
    // A single edit can destroy at most three distinct query trigrams. This
    // gives an optimistic score ceiling for every unexamined window. If any
    // could challenge the winner, leave the result for manual selection.
    let unexaminedScoreCeiling = -Infinity;
    for (const candidate of ranked) {
      if (candidate.evaluated) continue;
      const minimumEdits = Math.ceil((queryGrams.size - candidate.overlap) / 3);
      unexaminedScoreCeiling = Math.max(unexaminedScoreCeiling, 1 - minimumEdits / query.length);
    }
    const best = results[0], next = results[1];
    const autoOpenEligible = query.length >= 24 && Boolean(best) && best.score >= .9 &&
      (!next || best.score - next.score > .1) && unexaminedScoreCeiling < best.score - .1;
    postMessage({ id: data.id, results, autoOpenEligible, candidateCount: results.length,
      exactCandidateCount: exactLocations.size, fuzzySearchTruncated: ranked.some(candidate => !candidate.evaluated), ...metadata });
  } catch { postMessage({ id: data.id, autoOpenEligible: false, error: 'Verse search could not finish. Please try again.' }); }
};
