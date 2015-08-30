// XXX type checking on selectors (graceful error if malformed)

// LocalCollection: a set of documents that supports queries and modifiers.
// don't call this ctor directly.  use LocalCollection.find().

NewCursor = function (collection, selector, options) {
  var self = this;
  if (!options) options = {};

  self.collection = collection;
  self.sorter = null;

  //if(!Meteor.LOOKUPS) Meteor.LOOKUPS = {};
  //if(!Meteor.LOOKUPS[ collection.name ]) Meteor.LOOKUPS[ collection.name ] = 0;
  //Meteor.LOOKUPS[ collection.name ] += 1;

  if (LocalCollection._selectorIsIdPerhapsAsObject(selector)) {
    // stash for fast path
    self._selectorId = ( typeof selector === 'string' ? selector : selector._id );
    self.matcher = new Minimongo.Matcher(selector);
  } else {
    self._selectorId = undefined;
    self.matcher = new Minimongo.Matcher(selector);
    if (self.matcher.hasGeoQuery() || options.sort) {
      self.sorter = new Minimongo.Sorter(options.sort || [],
                                         { matcher: self.matcher });
    }
  }
  self.skip = options.skip;
  self.limit = options.limit;
  self.fields = options.fields;

  self._projectionFn = LocalCollection._compileProjection(self.fields || {});

  self._transform = LocalCollection.wrapTransform(options.transform);

  // by default, queries register w/ Tracker when it is available.
  if (typeof Tracker !== "undefined")
    self.reactive = (options.reactive === undefined) ? true : options.reactive;
};

NewCursor.prototype = LocalCollection.Cursor.prototype;

// Returns a collection of matching objects, but doesn't deep copy them.
//
// If ordered is set, returns a sorted array, respecting sorter, skip, and limit
// properties of the query.  if sorter is falsey, no sort -- you get the natural
// order.
//
// If ordered is not set, returns an object mapping from ID to doc (sorter, skip
// and limit should not be set).
//
// If ordered is set and this cursor is a $near geoquery, then this function
// will use an _IdMap to track each distance from the $near argument point in
// order to use it as a sort key. If an _IdMap is passed in the 'distances'
// argument, this function will clear it and use it for this purpose (otherwise
// it will just create its own _IdMap). The observeChanges implementation uses
// this to remember the distances after this function returns.
NewCursor.prototype._getRawObjects = function (options) {
  var self = this;
  options = options || {};

  // XXX use OrderedDict instead of array, and make IdMap and OrderedDict
  // compatible
  var results = options.ordered ? [] : new LocalCollection._IdMap;

  // fast path for single ID value
  if (self._selectorId !== undefined) {
    // If you have non-zero skip and ask for a single id, you get
    // nothing. This is so it matches the behavior of the '{_id: foo}'
    // path.
    if (self.skip)
      return results;

    var selectedDoc = self.collection._docs.get(self._selectorId);
    if (selectedDoc) {
      if (options.ordered)
        results.push(selectedDoc);
      else
        results.set(self._selectorId, selectedDoc);
    }
    return results;
  }

  // slow path for arbitrary selector, sort, skip, limit

  // in the observeChanges case, distances is actually part of the "query" (ie,
  // live results set) object.  in other cases, distances is only used inside
  // this function.
  var distances;
  if (self.matcher.hasGeoQuery() && options.ordered) {
    if (options.distances) {
      distances = options.distances;
      distances.clear();
    } else {
      distances = new LocalCollection._IdMap();
    }
  }

  self.collection._eachPossiblyMatchingDoc(self.matcher._selector, function (doc, id) {
    var matchResult = self.matcher.documentMatches(doc);
    if (matchResult.result) {
      if (options.ordered) {
        results.push(doc);
        if (distances && matchResult.distance !== undefined)
          distances.set(id, matchResult.distance);
      } else {
        results.set(id, doc);
      }
    }
    // Fast path for limited unsorted queries.
    // XXX 'length' check here seems wrong for ordered
    if (self.limit && !self.skip && !self.sorter &&
        results.length === self.limit)
      return false;  // break
    return true;  // continue
  });

  if (!options.ordered)
    return results;

  if (self.sorter) {
    var comparator = self.sorter.getComparator({distances: distances});
    results.sort(comparator);
  }

  var idx_start = self.skip || 0;
  var idx_end = self.limit ? (self.limit + idx_start) : results.length;
  return results.slice(idx_start, idx_end);
};


// Iterates over a subset of documents that could match selector; calls
// f(doc, id) on each of them.  Specifically, if selector specifies
// specific _id's, it only looks at those.  doc is *not* cloned: it is the
// same object that is in _docs.
LocalCollection.prototype._eachPossiblyMatchingDoc = function (selector, f) {
  var self = this;
  var specificIds = LocalCollection._idsMatchedBySelector(selector) || 
    self._idsMatchedByIndices(selector);
  if (specificIds) {
    for (var i = 0; i < specificIds.length; ++i) {
      var id = specificIds[i];
      var doc = self._docs.get(id);
      if (doc) {
        var breakIfFalse = f(doc, id);
        if (breakIfFalse === false)
          break;
      }
    }
  } else {
    self._docs.forEach(f);
  }
};


// XXX enforce rule that field names can't start with '$' or contain '.'
// (real mongodb does in fact enforce this)
// XXX possibly enforce that 'undefined' does not appear (we assume
// this in our handling of null and $exists)
LocalCollection.prototype.insert = function (doc, callback) {
  var self = this;
  doc = EJSON.clone(doc);

  if (!_.has(doc, '_id')) {
    // if you really want to use ObjectIDs, set this global.
    // Mongo.Collection specifies its own ids and does not use this code.
    doc._id = LocalCollection._useOID ? new LocalCollection._ObjectID()
                                      : Random.id();
  }
  var id = doc._id;

  if (self._docs.has(id))
    throw MinimongoError("Duplicate _id '" + id + "'");

  self._saveOriginal(id, undefined);
  self._docs.set(id, doc);
  self._addToIndices( doc );

  var queriesToRecompute = [];
  // trigger live queries that match
  for (var qid in self.queries) {
    var query = self.queries[qid];
    var matchResult = query.matcher.documentMatches(doc);
    if (matchResult.result) {
      if (query.distances && matchResult.distance !== undefined)
        query.distances.set(id, matchResult.distance);
      if (query.cursor.skip || query.cursor.limit)
        queriesToRecompute.push(qid);
      else
        LocalCollection._insertInResults(query, doc);
    }
  }

  _.each(queriesToRecompute, function (qid) {
    if (self.queries[qid])
      self._recomputeResults(self.queries[qid]);
  });
  self._observeQueue.drain();

  // Defer because the caller likely doesn't expect the callback to be run
  // immediately.
  if (callback)
    Meteor.defer(function () {
      callback(null, id);
    });
  return id;
};


LocalCollection.prototype.remove = function (selector, callback) {
  var self = this;

  // Easy special case: if we're not calling observeChanges callbacks and we're
  // not saving originals and we got asked to remove everything, then just empty
  // everything directly.
  if (self.paused && !self._savedOriginals && EJSON.equals(selector, {})) {
    var result = self._docs.size();
    self._docs.clear();
    _.each(self.queries, function (query) {
      if (query.ordered) {
        query.results = [];
      } else {
        query.results.clear();
      }
    });
    if (callback) {
      Meteor.defer(function () {
        callback(null, result);
      });
    }
    return result;
  }

  var matcher = new Minimongo.Matcher(selector);
  var remove = [];
  self._eachPossiblyMatchingDoc(selector, function (doc, id) {
    if (matcher.documentMatches(doc).result)
      remove.push(id);
  });

  var queriesToRecompute = [];
  var queryRemove = [];
  for (var i = 0; i < remove.length; i++) {
    var removeId = remove[i];
    var removeDoc = self._docs.get(removeId);
    _.each(self.queries, function (query, qid) {
      if (query.matcher.documentMatches(removeDoc).result) {
        if (query.cursor.skip || query.cursor.limit)
          queriesToRecompute.push(qid);
        else
          queryRemove.push({qid: qid, doc: removeDoc});
      }
    });
    self._saveOriginal(removeId, removeDoc);
    self._docs.remove(removeId);
    self._removeFromIndices( removeDoc );
  }

  // run live query callbacks _after_ we've removed the documents.
  _.each(queryRemove, function (remove) {
    var query = self.queries[remove.qid];
    if (query) {
      query.distances && query.distances.remove(remove.doc._id);
      LocalCollection._removeFromResults(query, remove.doc);
    }
  });
  _.each(queriesToRecompute, function (qid) {
    var query = self.queries[qid];
    if (query)
      self._recomputeResults(query);
  });
  self._observeQueue.drain();
  result = remove.length;
  if (callback)
    Meteor.defer(function () {
      callback(null, result);
    });
  return result;
};


// this is called by the LocalCollection.update function for matching docs
LocalCollection.prototype._modifyAndNotify = function (
    doc, mod, recomputeQids, arrayIndices) {
  var self = this;

  var matched_before = {};
  for (var qid in self.queries) {
    var query = self.queries[qid];
    if (query.ordered) {
      matched_before[qid] = query.matcher.documentMatches(doc).result;
    } else {
      // Because we don't support skip or limit (yet) in unordered queries, we
      // can just do a direct lookup.
      matched_before[qid] = query.results.has(doc._id);
    }
  }

  var old_doc = EJSON.clone(doc);

  LocalCollection._modify(doc, mod, {arrayIndices: arrayIndices});

  //update indices if necessary
  _.each( self._indices, function( index ){
    index.perhapsUpdate( doc, old_doc );
  });

  for (qid in self.queries) {
    query = self.queries[qid];
    var before = matched_before[qid];
    var afterMatch = query.matcher.documentMatches(doc);
    var after = afterMatch.result;
    if (after && query.distances && afterMatch.distance !== undefined)
      query.distances.set(doc._id, afterMatch.distance);

    if (query.cursor.skip || query.cursor.limit) {
      // We need to recompute any query where the doc may have been in the
      // cursor's window either before or after the update. (Note that if skip
      // or limit is set, "before" and "after" being true do not necessarily
      // mean that the document is in the cursor's output after skip/limit is
      // applied... but if they are false, then the document definitely is NOT
      // in the output. So it's safe to skip recompute if neither before or
      // after are true.)
      if (before || after)
        recomputeQids[qid] = true;
    } else if (before && !after) {
      LocalCollection._removeFromResults(query, doc);
    } else if (!before && after) {
      LocalCollection._insertInResults(query, doc);
    } else if (before && after) {
      LocalCollection._updateInResults(query, doc, old_doc);
    }
  }
};


LocalCollection.prototype._idsMatchedByIndices = function(selector){
  var self = this;
  //if( !Meteor.LOGIT ){
  //  Meteor.LOGIT = [];
  //}
  if( !self._indices ){
  //  Meteor.LOGIT.push( self.name + ': no index for ' + EJSON.stringify( selector ) );
    return null;
  }

  // If any of the indices are present in the selector, get list of matching
  // documents for each index
  var matchedIds = _.map( self._indices, function( index ){
    if( index.selectorHasMatchingKeys( selector ) ){
      return index.getMatchingIds( selector ) || null;
    } else {
      return null;
    }
  });

  // intersect lists to get documents that match all indices
  var matchedIds = _.reduce( matchedIds, function( matchingAll, matchingOne ){
    if( matchingAll !== null && matchingOne !== null ){
      return _.intersection( matchingAll, matchingOne );
    } else {
      return matchingAll || matchingOne;
    }
  });

  //if( matchedIds ){
  //  //Meteor.LOGIT.push('index for ' + EJSON.stringify( selector ) + ' len ' + matchedIds.length );
  //} else {
  //  Meteor.LOGIT.push('no matched ids for ' + EJSON.stringify( selector ) );
  //}

  return matchedIds;
}

//
// indexKeys can be a string or array of strings
// XXX dot operator on index key is not supported yet
//
LocalCollection.prototype._ensureIndex = function( indexKeys ){
  var self = this;

  if( typeof indexKeys === 'string' )
    indexKeys = [ indexKeys ];

  // we only support simple string indices for now, no dot operator
  _.each( indexKeys, function( key ){
    if( key.indexOf('.') !== -1 ){
      throw new Error('Dot operators are not yet supported in minimongo index');
    }
  });

  indexKeys.sort(); // to make sure equivalent indices get the same name
  var indexName = indexKeys.join('_');


  if( !self._indices ){
    self._indices = {};
  }
  if( self._indices[ indexName ] ){
    console.error( 'index ' + indexName + ' is already defined!' );
  }
  self._indices[ indexName ] = new Index( indexName, indexKeys );

  self._docs.forEach( self._addToIndices.bind( self ) );
};

LocalCollection.prototype._addToIndices = function( doc ){
  var self = this;
  _.each( self._indices, function( index ){
    index.add( doc );
  });
};

LocalCollection.prototype._removeFromIndices = function( doc ){
  var self = this;
  _.each( self._indices, function( index ){
    index.remove( doc );
  });
};

// don't use, just for testing
LocalCollection.prototype._dropIndex = function( indexName ){
  var self = this;
  delete self._indices[ indexName ];
  if( _.keys( self._indices ).length === 0 ){
    self._indices = null;
  }
};

LocalCollection.Cursor = NewCursor;

//
// XXX JSON.stringify converts undefined to null. Is that a problem
// for the way we create our index keys?
// 

Index = function Index( name, keys ){
  var self = this;

  self.name = name;
  self._keys = keys;
  self._IdMap = new IdMap();
};

// doc must have _id to be added to index
Index.prototype.add = function( doc ){
  var self = this;

  if( !doc._id ){
    return;
  }

  var indexKey = self._getIndexKey( doc );
  if( !self._IdMap.has( indexKey ) ){
    self._IdMap.set( indexKey, new IdSet() );
  }
  self._IdMap.get( indexKey ).add( doc._id );
};

Index.prototype.remove = function( doc ){
  var self = this;

  if( !doc._id ){
    return false;
  }

  var indexKey = self._getIndexKey( doc );

  if( !self._IdMap.has( indexKey ) ){
    console.error( 'trying to remove document, but document is not in index ' + self.name);
    console.error( doc );
    return false;
  }
  self._IdMap.get( indexKey ).remove( doc._id );

  return true;
};

Index.prototype.perhapsUpdate = function perhapsUpdate( newDoc, oldDoc ){
  var self = this;

  var oldKey = self._getIndexKey( oldDoc );
  var newKey = self._getIndexKey( newDoc );
  if( oldKey !== newKey ){
    //XXX maybe use the indexKeys we just computed
    self.remove( oldDoc ) && self.add( newDoc );
  }
};

Index.prototype.getMatchingIds = function( selector ){
  var self = this;
  var indexKey = self._getIndexKey( selector );
  var matchingIdSet = self._IdMap.get( indexKey );
  if( matchingIdSet ){
    return matchingIdSet.values();
  }
  return [];
}

// IndexKey is a projection of the index fields of the doc onto an array
Index.prototype._getIndexKey = function( doc ){
  var self = this;

  indexKey = _.map( self._keys, function( key ){ return doc[ key ]; });
  return indexKey;
};

// Test if the selector contains all keys of the index
// XXX Values in selector must be strings for now. Support $lt & co. later
Index.prototype.selectorHasMatchingKeys = function canUseIndex( selector ){
  var self = this;

  // XXX from Underscore.String (http://epeli.github.com/underscore.string/)
  // quickfix to stop travis tests from failing because str.startsWith is undefined
  var startsWith = function(str, starts) {
    return str.length >= starts.length && str.substring(0, starts.length) === starts;
  };

  var startsWithDollar = function startsWithDollar( str ){
    return startsWith( str, '$');
  }

  var isSupportedIndexType = function isSupportedIndexType( selector, key ){
    if ( typeof selector[ key ] !== 'object' && typeof selector[ key ] !== 'function' ){
      return true;
    }
    if ( typeof selector[ key ] === 'object' ){
      if ( selector[ key ] === null ){
        return true;
      } else {
        return !_.any( _.keys( selector[ key ] ), startsWithDollar );
      }
    }
    return false;
  };

  return _.every( 
      _.map( self._keys, function( key ){
        return _.has( selector, key ) && isSupportedIndexType( selector, key );
      } )
    );
};

/*
 * IdSet is a very simple set implementation that supports add and remove
 * It supports only strings, because that's the only type an _id should have.
 *
 * XXX replace this with ES6 set (or its polyfill)
 * XXX add efficient set intersection
 * XXX doesn't deal with hash collisions, but there shouldn't be any anyway
 */
IdSet = function(){
  var self = this;
  self._set = {};
}

IdSet.prototype.add = function( value ){
  var self = this;
  if( typeof value !== 'string' )
    throw new Error('IdSet can only store strings, not ' + typeof value );
  self._set[ value ] = true;
}

IdSet.prototype.remove = function( value ){
  var self = this;
  delete self._set[ value ];
}

IdSet.prototype.values = function(){
  var self = this;
  return _.keys( self._set );
}

/*
 * IdMap ... will be its own package soon...
 */

//TODO: only redefine if it was not defined already in minimongo.
IdMap = function (idStringify, idParse) {
  var self = this;
  self._map = {};
  self._idStringify = idStringify || JSON.stringify;
  self._idParse = idParse || JSON.parse;
};

// Some of these methods are designed to match methods on OrderedDict, since
// (eg) ObserveMultiplex and _CachingChangeObserver use them interchangeably.
// (Conceivably, this should be replaced with "UnorderedDict" with a specific
// set of methods that overlap between the two.)

_.extend(IdMap.prototype, {
  get: function (id) {
    var self = this;
    var key = self._idStringify(id);
    return self._map[key];
  },
  /*getDefault: functon(id, def){
    var self = this;
    return self.has( id ) ? self.get(id) : def;
  },*/
  set: function (id, value) {
    var self = this;
    var key = self._idStringify(id);
    self._map[key] = value;
  },
  remove: function (id) {
    var self = this;
    var key = self._idStringify(id);
    delete self._map[key];
  },
  has: function (id) {
    var self = this;
    var key = self._idStringify(id);
    return _.has(self._map, key);
  },
  empty: function () {
    var self = this;
    return _.isEmpty(self._map);
  },
  clear: function () {
    var self = this;
    self._map = {};
  },
  // Iterates over the items in the map. Return `false` to break the loop.
  forEach: function (iterator) {
    var self = this;
    // don't use _.each, because we can't break out of it.
    var keys = _.keys(self._map);
    for (var i = 0; i < keys.length; i++) {
      var breakIfFalse = iterator.call(null, self._map[keys[i]],
                                       self._idParse(keys[i]));
      if (breakIfFalse === false)
        return;
    }
  },
  size: function () {
    var self = this;
    return _.size(self._map);
  },
  setDefault: function (id, def) {
    var self = this;
    var key = self._idStringify(id);
    if (_.has(self._map, key))
      return self._map[key];
    self._map[key] = def;
    return def;
  },
  // Assumes that values are EJSON-cloneable, and that we don't need to clone
  // IDs (ie, that nobody is going to mutate an ObjectId).
  clone: function () {
    var self = this;
    var clone = new IdMap(self._idStringify, self._idParse);
    self.forEach(function (value, id) {
      clone.set(id, EJSON.clone(value));
    });
    return clone;
  }
});



