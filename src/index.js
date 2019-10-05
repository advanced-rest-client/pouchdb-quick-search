import lunr from 'lunr';
import stringify from 'json-stable-stringify';
import extend from 'pouchdb-extend';
import { MD5 } from './utils.js';
export { query as _searchQuery, viewCleanup } from '@advanced-rest-client/pouchdb-mapreduce-no-ddocs';
const TYPE_TOKEN_COUNT = 'a';
const TYPE_DOC_INFO = 'b';

function add(left, right) {
  return left + right;
}
// returns a sorted list of scored results, like:
// [{id: {...}, score: 0.2}, {id: {...}, score: 0.1}];
//
// some background: normally this would be implemented as cosine similarity
// using tf-idf, which is equal to
// dot-product(q, d) / (norm(q) * norm(doc))
// (although there is no point in calculating the query norm,
// because all we care about is the relative score for a given query,
// so we ignore it, lucene does this too)
//
//
// but instead of straightforward cosine similarity, here I implement
// the dismax algorithm, so the doc score is the
// sum of its fields' scores, and this is done on a per-query-term basis,
// then the maximum score for each of the query terms is the one chosen,
// i.e. max(sumOfQueryTermScoresForField1, sumOfQueryTermScoresForField2, etc.)
//

function calculateDocumentScores(queryTerms, termDFs, docIdsToFieldsToQueryTerms,
                                 docIdsToFieldsToNorms, fieldBoosts) {

  const results = Object.keys(docIdsToFieldsToQueryTerms).map(function(docId) {
    const fieldsToQueryTerms = docIdsToFieldsToQueryTerms[docId];
    const fieldsToNorms = docIdsToFieldsToNorms[docId];

    const queryScores = queryTerms.map(function(queryTerm) {
      return fieldsToQueryTerms.map(function (queryTermsToCounts, fieldIdx) {
        const fieldNorm = fieldsToNorms[fieldIdx];
        if (!(queryTerm in queryTermsToCounts)) {
          return 0;
        }
        const termDF = termDFs[queryTerm];
        const termTF = queryTermsToCounts[queryTerm];
        const docScore = termTF / termDF; // TF-IDF for doc
        const queryScore = 1 / termDF; // TF-IDF for query, count assumed to be 1
        const boost = fieldBoosts[fieldIdx].boost;
        return docScore * queryScore * boost / fieldNorm; // see cosine sim equation
      }).reduce(add, 0);
    });

    let maxQueryScore = 0;
    queryScores.forEach(function (queryScore) {
      if (queryScore > maxQueryScore) {
        maxQueryScore = queryScore;
      }
    });

    return {
      id: docId,
      score: maxQueryScore
    };
  });

  results.sort(function (a, b) {
    return a.score < b.score ? 1 : (a.score > b.score ? -1 : 0);
  });

  return results;
}

async function applyIncludeDocs(pouch, rows) {
  const docs = await Promise.all(rows.map((row) => pouch.get(row.id)));
  docs.forEach((doc, i) => {
    rows[i].doc = doc;
  });
  return rows;
}

// create a convenient object showing highlighting results
// this is designed to be like solr's highlighting feature, so it
// should return something like
// {'fieldname': 'here is some <strong>highlighted text</strong>.'}
//
async function applyHighlighting(pouch, opts, rows, fieldBoosts,
                           docIdsToFieldsToQueryTerms) {

  const pre = opts.highlighting_pre || '<strong>';
  const post = opts.highlighting_post || '</strong>';

  for (let i = 0, len = rows.length; i < len; i++) {
    const row = rows[i];
    let doc;
    if (!row.doc) {
      doc = await pouch.get(row.id);
    } else {
      doc = row.doc;
    }
    /* eslint-disable-next-line */
    row.highlighting = {};
    for (let j = 0, jLen = docIdsToFieldsToQueryTerms[row.id].length; j < jLen; j++) {
      const queryTerms = docIdsToFieldsToQueryTerms[row.id][j];
      const fieldBoost = fieldBoosts[j];
      const fieldName = fieldBoost.field;
      let text = getText(fieldBoost, doc);
      // TODO: this is fairly naive highlighting code; could improve
      // the regex
      Object.keys(queryTerms).forEach(function (queryTerm) {
        const regex = new RegExp('(' + queryTerm + '[a-z]*)', 'gi');
        const replacement = pre + '$1' + post;
        text = text.replace(regex, replacement);
        row.highlighting[fieldName] = text;
      });
    }
  }
  return rows;
}

// return true if filtered, false otherwise
// limit the try/catch to its own function to avoid deoptimization
function isFiltered(doc, filter, db) {
  try {
    return !!(filter && !filter(doc));
  } catch (e) {
    db.emit('error', e);
    return true;
  }
}

// get all the tokens found in the given text (non-unique)
// in the future, we might expand this to do more than just
// English. Also, this is a private Lunr API, hence why
// the Lunr version is pegged.
function getTokenStream(text) {
  const tokens = lunr.tokenizer(text);
  return tokens.map((token) => lunr.trimmer(token).toString());
}

function handleNestedObjectArrayItem(fieldBoost, deepField) {
  return function(one) {
    return getText(extend({}, fieldBoost, {
      deepField
    }), one);
  };
}

// given an object containing the field name and/or
// a deepField definition plus the doc, return the text for
// indexing
function getText(fieldBoost, doc) {
  let text;
  if (!fieldBoost.deepField) {
    text = doc[fieldBoost.field];
  } else { // "Enhance."
    text = doc;
    for (let i = 0, len = fieldBoost.deepField.length; i < len; i++) {
      if (Array.isArray(text)) {
        text = text.map(handleNestedObjectArrayItem(fieldBoost, fieldBoost.deepField.slice(i)));
      } else {
        text = text && text[fieldBoost.deepField[i]];
      }
    }
  }
  if (text) {
    if (Array.isArray(text)) {
      text = text.join(' ');
    } else if (typeof text !== 'string') {
      text = text.toString();
    }
  }
  return text;
}

// map function that gets passed to map/reduce
// emits two types of key/values - one for each token
// and one for the field-len-norm
function createMapFunction(fieldBoosts, filter, db) {
  return function(doc, emit) {
    if (isFiltered(doc, filter, db)) {
      return;
    }
    const docInfo = [];
    for (let i = 0, len = fieldBoosts.length; i < len; i++) {
      const fieldBoost = fieldBoosts[i];
      const text = getText(fieldBoost, doc);
      let fieldLenNorm;
      if (text) {
        const terms = getTokenStream(text);
        for (let j = 0, jLen = terms.length; j < jLen; j++) {
          const term = terms[j];
          // avoid emitting the value if there's only one field;
          // it takes up unnecessary space on disk
          const value = fieldBoosts.length > 1 ? i : undefined;
          emit(TYPE_TOKEN_COUNT + term, value);
        }
        fieldLenNorm = Math.sqrt(terms.length);
      } else { // no tokens
        fieldLenNorm = 0;
      }
      docInfo.push(fieldLenNorm);
    }
    emit(TYPE_DOC_INFO + doc._id, docInfo);
  };
}

const search = async function(opts, callback) {
  if (typeof opts !== 'object') {
    return callback(new Error('you must provide search options'));
  }
  const q = opts.query || opts.q;
  const mm = 'mm' in opts ? (parseFloat(opts.mm) / 100) : 1; // e.g. '75%'
  let fields = opts.fields;
  const highlighting = opts.highlighting;
  const includeDocs = opts.include_docs;
  const destroy = opts.destroy;
  const stale = opts.stale;
  const limit = opts.limit;
  const build = opts.build;
  const skip = opts.skip || 0;
  const language = opts.language || 'en';
  const filter = opts.filter;

  if (Array.isArray(fields)) {
    const fieldsMap = {};
    fields.forEach((field) => {
      fieldsMap[field] = 1; // default boost
    });
    fields = fieldsMap;
  }

  const fieldBoosts = Object.keys(fields).map((field) => {
    const deepField = field.indexOf('.') !== -1 && field.split('.');
    return {
      field: field,
      deepField,
      boost: fields[field]
    };
  });

  // let index = indexes[language];
  // if (!index) {
  //   index = indexes[language] = lunr();
  //   if (Array.isArray(language)) {
  //     index.use(global.lunr.multiLanguage.apply(this, language));
  //   } else if (language !== 'en') {
  //     index.use(global.lunr[language]);
  //   }
  // }

  // the index we save as a separate database is uniquely identified
  // by the fields the user want to index (boost doesn't matter)
  // plus the tokenizer

  const indexParams = {
    language: language,
    fields: fieldBoosts.map((x) => x.field).sort()
  };

  if (filter) {
    indexParams.filter = filter.toString();
  }

  const persistedIndexName = 'search-' + MD5(stringify(indexParams));

  const mapFun = createMapFunction(fieldBoosts, filter, this);

  const queryOpts = {
    saveAs: persistedIndexName
  };
  if (destroy) {
    queryOpts.destroy = true;
    return await this._searchQuery(mapFun, queryOpts);
  } else if (build) {
    delete queryOpts.stale; // update immediately
    queryOpts.limit = 0;
    await this._searchQuery(mapFun, queryOpts);
    return {
      ok: true
    }
  }

  // it shouldn't matter if the user types the same
  // token more than once, in fact I think even Lucene does this
  // special cases like boingo boingo and mother mother are rare
  const queryTerms = getTokenStream(q);
  if (!queryTerms.length) {
    return { total_rows: 0, rows: [] };
  }
  queryOpts.keys = queryTerms.map((queryTerm) => TYPE_TOKEN_COUNT + queryTerm);

  if (typeof stale === 'string') {
    queryOpts.stale = stale;
  }

  // search algorithm, basically classic TF-IDF
  //
  // step 1: get the doc+fields associated with the terms in the query
  // step 2: get the doc-len-norms of those document fields
  // step 3: calculate document scores using tf-idf
  //
  // note that we follow the Lucene convention (established in
  // DefaultSimilarity.java) of computing doc-len-norm (in our case, tecnically
  // field-lennorm) as Math.sqrt(numTerms),
  // which is an optimization that avoids having to look up every term
  // in that document and fully recompute its scores based on tf-idf
  // More info:
  // https://lucene.apache.org/core/3_6_0/api/core/org/apache/lucene/search/Similarity.html
  //
  // console.log('STEP 1');
  // step 1
  const res = await this._searchQuery(mapFun, queryOpts);
  if (!res.rows.length) {
    return { total_rows: 0, rows: [] };
  }
  let totalRows = 0;
  const docIdsToFieldsToQueryTerms = {};
  const termDFs = {};
  res.rows.forEach(function(row) {
    const term = row.key.substring(1);
    const field = row.value || 0;

    // calculate termDFs
    if (!(term in termDFs)) {
      termDFs[term] = 1;
    } else {
      termDFs[term]++;
    }

    // calculate docIdsToFieldsToQueryTerms
    if (!(row.id in docIdsToFieldsToQueryTerms)) {
      const arr = docIdsToFieldsToQueryTerms[row.id] = [];
      for (let i = 0; i < fieldBoosts.length; i++) {
        arr[i] = {};
      }
    }

    const docTerms = docIdsToFieldsToQueryTerms[row.id][field];
    if (!(term in docTerms)) {
      docTerms[term] = 1;
    } else {
      docTerms[term]++;
    }
  });

  // apply the minimum should match (mm)
  if (queryTerms.length > 1) {
    Object.keys(docIdsToFieldsToQueryTerms).forEach(function(docId) {
      const allMatchingTerms = {};
      const fieldsToQueryTerms = docIdsToFieldsToQueryTerms[docId];
      Object.keys(fieldsToQueryTerms).forEach(function(field) {
        Object.keys(fieldsToQueryTerms[field]).forEach(function(term) {
          allMatchingTerms[term] = true;
        });
      });
      const numMatchingTerms = Object.keys(allMatchingTerms).length;
      const matchingRatio = numMatchingTerms / queryTerms.length;
      if ((Math.floor(matchingRatio * 100) / 100) < mm) {
        delete docIdsToFieldsToQueryTerms[docId]; // ignore this doc
      }
    });
  }

  if (!Object.keys(docIdsToFieldsToQueryTerms).length) {
    return { total_rows: 0, rows: [] };
  }

  const keys = Object.keys(docIdsToFieldsToQueryTerms).map(function(docId) {
    return TYPE_DOC_INFO + docId;
  });

  const queryOpts2 = {
    saveAs: persistedIndexName,
    keys,
    stale
  };
  // console.log('STEP 2');
  // step 2
  const res2 = await this._searchQuery(mapFun, queryOpts2);
  const docIdsToFieldsToNorms = {};
  res2.rows.forEach(function(row) {
    docIdsToFieldsToNorms[row.id] = row.value;
  });
  // console.log('STEP 3');
  // step 3
  // now we have all information, so calculate scores
  let rows = calculateDocumentScores(queryTerms, termDFs,
    docIdsToFieldsToQueryTerms, docIdsToFieldsToNorms, fieldBoosts);
  totalRows = rows.length;
  // filter before fetching docs or applying highlighting
  // for a slight optimization, since for now we've only fetched ids/scores
  rows = (typeof limit === 'number' && limit >= 0) ?
    rows.slice(skip, skip + limit) : skip > 0 ? rows.slice(skip) : rows;

  if (includeDocs) {
    rows = await applyIncludeDocs(this, rows);
  }
  if (highlighting) {
    rows = await applyHighlighting(this, opts, rows, fieldBoosts, docIdsToFieldsToQueryTerms);
  }
  return { total_rows: totalRows, rows: rows };
};
export { search };
