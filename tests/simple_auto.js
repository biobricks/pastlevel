var test = require('tape');
var temp = require('temp').track();
var util = require('util');
var levelup = require('levelup');
var pastlevel = require('../index.js');

/*
  check that basic "change, checkout"-functionality 
  is working in auto mode

  with autocommit on:
  put a row, 
  get the row again, 
  change the row,
  get the row again,
  check out first commit
  get the row again
*/

var ldb = levelup(temp.mkdirSync());
var db = pastlevel(ldb);

test('simple_auto', function(t) {

    t.plan(6);

    var firstID;

    db.put('cookie', 'kat', function(err) {
        if(err) return t.fail("Error: " + err);
        
        console.log("put success with commit id:", db.cur());

        firstID = db.cur();
        t.equal(typeof firstID, 'string');

        db.get('cookie', function(err, val) {
            if(err) return t.fail("Error: " +  err);

            t.equal(val, 'kat');

            db.put('cookie', 'cat', function(err) {
                if(err) return t.fail("Error: " + err);
               
                db.get('cookie', function(err, val) {
                    if(err) return t.fail("Error: " + err);

                    t.equal(val, 'cat');

                    db.checkout(firstID, function(err, id) {
                        if(err) return t.fail("Error: " + err);
                        
                        t.equal(typeof id, 'string');
                        t.equal(id, firstID);

                        db.get('cookie', function(err, val) {
                            if(err) return t.fail("Error: " + err);

                            t.equal(val, 'kat');
                        });
                    });
                });
            });
        });
    });
});
