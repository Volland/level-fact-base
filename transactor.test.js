var _ = require('lodash');
var test = require('tape');
var async = require('async');
var level = require('levelup');
var memdown = require('memdown');
var genRandomString = require('./utils/genRandomString');

var Transactor = require('./transactor');
var Inquisitor = require('./inquisitor');

test("ensure transact persists stuff to the db", function(t){
  var db = level(memdown);

  Transactor(db, {}, function(err, transactor){
    if(err){
      return t.end(err);
    }
    transactor.transact([
      ["0001", "name", "bob"],
      ["0001", "age",   "34"],
      ["0002", "name", "jim"],
      ["0002", "age",   "23"]
    ], {
      user_id: "0001"
    }, function(err){
      if(err){
        return t.end(err);
      }
      var all_data = [];
      db.readStream().on('data', function(data){
        all_data.push(data);
      }).on('close', function(){
        t.equals(all_data.length, 24);
        t.end();
      });
    });
  });
});

test("ensure transactor warms up with the latest transaction id", function(t){
  var db = level(memdown);

  Transactor(db, {}, function(err, transactor){
    if(err){
      return t.end(err);
    }
    async.series([
      async.apply(transactor.transact, [["bob", "is", "cool"]], {}),
      async.apply(transactor.transact, [["bob", "is", "NOT cool"]], {}),
      async.apply(transactor.transact, [["bob", "is", "cool"]], {})
    ], function(err){
      if(err){
        return t.end(err);
      }

      var inq = Inquisitor(db);
      inq.q([["?e", "?a", "?v", "?txn"]], [{}], function(err, results){
        if(err){
          return t.end(err);
        }
        var txns = _.unique(_.pluck(results, "?txn")).sort();
        t.deepEqual(txns, [1, 2, 3]);

        //warm up a new transactor to see where it picks up
        Transactor(db, {}, function(err, transactor2){
          if(err){
            return t.end(err);
          }
          transactor2.transact([["bob", "is", "NOT cool"]], {}, function(err){
            if(err){
              return t.end(err);
            }
            inq.q([["?e", "?a", "?v", "?txn"]], [{}], function(err, results){
              var txns = _.unique(_.pluck(results, "?txn")).sort();
              t.deepEqual(txns, [1, 2, 3, 4]);
              t.end(err);
            });
          });
        });
      });
    });
  });
});
