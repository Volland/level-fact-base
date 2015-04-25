var _ = require('lodash');
var λ = require('contra');
var escapeRegExp = require('escape-regexp');
var HashIndex = require('level-hash-index');
var toPaddedBase36 = require('./utils/toPaddedBase36');

var escapeVar = function(elm){
  return _.isString(elm) ? elm.replace(/^\\/, "\\\\").replace(/^\?/, "\\?") : elm;
};

var unEscapeVar = function(elm){
  return _.isString(elm) ? elm.replace(/^\\/, "") : elm;
};

var isVar = function(elm){
  return _.isString(elm) && elm[0] === '?';
};

var isTheThrowAwayVar = function(elm){
  return elm === '?_';
};

var bindToTuple = function(tuple, binding){
  return tuple.map(function(e){
    if(binding.hasOwnProperty(e)){
      return escapeVar(binding[e]);
    }
    return e;
  });
};

var parseElement = function(hindex, tuple, i, callback){
  var elm = tuple.length < i + 1 ? '?_' : tuple[i];
  if(isTheThrowAwayVar(elm)){
    callback(null, {is_blank: true});
  }else if(isVar(elm)){
    callback(null, {var_name: elm});
  }else if(i < 3 && _.isString(elm)){
    elm = unEscapeVar(elm);
    hindex.getHash(elm, function(err, hash){
      if(err) callback(err);
      else callback(null, {value: elm, hash: hash});
    });
  }else if(i === 3 && _.isNumber(elm)){
    var txn = toPaddedBase36(elm, 6);
    callback(null, {value: txn, hash: txn});
  }else if(i === 4 && (elm === true || elm === false)){
    callback(null, {value: elm, hash: elm});
  }else{
    callback(new Error('element ' + i + ' in tuple has invalid type'));
  }
};

var parseTuple = function(hindex, tuple, callback){
  λ.concurrent({
    e: λ.curry(parseElement, hindex, tuple, 0),
    a: λ.curry(parseElement, hindex, tuple, 1),
    v: λ.curry(parseElement, hindex, tuple, 2),
    t: λ.curry(parseElement, hindex, tuple, 3),
    o: λ.curry(parseElement, hindex, tuple, 4)
  }, callback);
};

var selectIndex = (function(){
  var getKnowns = function(q_fact){
    var knowns = [];
    "eav".split("").forEach(function(key){
      if(q_fact[key].hasOwnProperty("hash")){
        knowns.push(key);
      }
    });
    return knowns.sort().join("");
  };
  var mapping = {
    '': 'eavto',
    'e': 'eavto',
    'a': 'aevto',
    'v': 'vaeto',
    'av': 'aveto',
    'ev': 'eavto',
    'ae': 'eavto',
    'aev': 'eavto',
  };
  return function(q_fact){
    return 'eavto';//TODO select the index based on attribute schema
    return mapping[getKnowns(q_fact)];
  };
}());

var toMatcher = function(index_to_use, q_fact){

  var prefix = index_to_use + '!';
  var prefix_parts = [];
  var found_a_gap = false;

  var regex = escapeRegExp(prefix) + index_to_use.split("").map(function(k){
    if(q_fact[k].hasOwnProperty('hash')){
      if(!found_a_gap){
        prefix_parts.push(q_fact[k].hash);
      }
      return escapeRegExp(q_fact[k].hash);
    }else{
      found_a_gap = true;
      return '.*';
    }
  }).join(escapeRegExp('!'));

  return {
    prefix: prefix + prefix_parts.join('!'),
    matchRegExp: new RegExp(regex)
  };
}; 

var findMatchingKeys = function(db, matcher, callback){
  var results = [];
  db.createReadStream({
    keys: true,
    values: false,
    gte: matcher.prefix + '\x00',
    lte: matcher.prefix + '\xFF',
  }).on('data', function(data){
    if(matcher.matchRegExp.test(data)){
      results.push(data);
    }
  }).on('error', function(err){
    callback(err);
  }).on('end', function(){
    callback(null, results);
  });
};

var keyToFact = function(key){
  var parts = key.split("!");
  var index_name = parts[0];
  var fact = {};
  index_name.split('').forEach(function(k, i){
    var part = parts[i + 1];
    if(k === 't'){
      fact[k] = {value: parseInt(part, 36)};
    }else if(k === 'o'){
      fact[k] = {value: part === '1'};
    }else{
      fact[k] = part;
    }
  });
  return fact;
};

var bindKeys = function(matching_keys, q_fact){
  var binding = {};//to ensure unique-ness

  var only_the_latest = q_fact.t.is_blank;//TODO also based on the cardiality of q_fact.a's schema
  var latest_for = {};//latest for the same e+a

  var var_names = "eavto".split('').filter(function(k){
    return q_fact[k].hasOwnProperty('var_name');
  }).map(function(k){
    return [q_fact[k].var_name, k];
  });

  matching_keys.forEach(function(key, i){
    var fact = keyToFact(key);

    var key_for_latest_for = only_the_latest ? fact.e + fact.a : i;

    if(latest_for.hasOwnProperty(key_for_latest_for)){
      if(latest_for[key_for_latest_for].txn > fact.t.value){
        return;//not the latest, so skip the rest
      }
    }

    var vars = {};
    var hash_key = '';
    var_names.forEach(function(p){
      var k = p[1];
      vars[p[0]] = fact[k];
      hash_key += _.isString(fact[k]) ? fact[k] : fact[k].value;
    });
    binding[hash_key] = vars;
    latest_for[key_for_latest_for] = {txn: fact.t.value, hash_key: hash_key};
  });
  return _.unique(_.pluck(latest_for, 'hash_key')).map(function(key){
    return binding[key];
  });
};

var qTuple = function(db, hindex, tuple, orig_binding, callback){
  parseTuple(hindex, bindToTuple(tuple, orig_binding), function(err, q_fact){
    if(err){
      if(err.type === 'NotFoundError'){
        //one of the tuple values were not found in the hash, so there must be no results
        return callback(null, []);
      }
      return callback(err);
    }
    var index_to_use = selectIndex(q_fact);

    findMatchingKeys(db, toMatcher(index_to_use, q_fact), function(err, matching_keys){
      if(err) return callback(err);

      var bindings = bindKeys(matching_keys, q_fact);

      //de-hash the bindings
      λ.map(bindings, function(binding, callback){
        λ.map(_.pairs(binding), function(p, callback){
          if(_.isString(p[1])){
            hindex.get(p[1], function(err, val){
              callback(err, [p[0], val]);
            });
          }else{
            callback(null, [p[0], p[1].value]);
          }
        }, function(err, pairs){
          callback(err, _.assign({}, orig_binding, _.object(pairs)));
        });
      }, callback);
    });
  });
};

module.exports = function(db, options){
  options = options || {};

  var hindex = options.HashIndex || HashIndex(db);
  var qTuple_bound = function(tuple, binding, callback){
    if(!_.isArray(tuple)){
      return callback(new Error("tuple must be an array"));
    }
    if(!_.isPlainObject(binding)){
      return callback(new Error("binding must be a plain object"));
    }
    qTuple(db, hindex, tuple, binding, callback);
  };
  var q = function(tuples, bindings, callback){
    if(!_.isArray(tuples)){
      return callback(new Error("q expects an array of tuples"));
    }
    if(!_.isArray(bindings)){
      return callback(new Error("q expects an array bindings"));
    }

    var memo = bindings;
    λ.each.series(tuples, function(tuple, callback){
      λ.map(memo, function(binding, callback){
        qTuple(db, hindex, tuple, binding, callback);
      }, function(err, next_bindings){
        if(err) return callback(err);
        memo = _.flatten(next_bindings);
        callback();
      });
    }, function(err){
      if(err) callback(err);
      else callback(null, memo);
    });
  };
  return {
    qTuple: qTuple_bound,
    q: q,
    getEntity: function(e, callback){
      q([["?e", "?a", "?v"]], [{"?e": e}], function(err, results){
        if(err) return callback(err);
        var o = {};
        results.forEach(function(result){
          o[result["?a"]] = result["?v"];
          //TODO cardinality = multiple
        });
        callback(null, o);
      });
    }
  };
};
