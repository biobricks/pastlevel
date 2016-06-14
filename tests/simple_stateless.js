var test = require('tape');
var temp = require('temp').track();
var util = require('util');
var levelup = require('levelup');
var uuid = require('uuid').v4;
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
var db = pastlevel(ldb, {
    stateless: true,
    debug: true
});

test('simple_stateless', function(t) {

    t.plan(5);

    var firstCommit = uuid();

    db.put('cookie', 'kat', {commit: firstCommit}, function(err) {
        if(err) return t.fail("Error: " + err);

        db.get('cookie', {commit: firstCommit}, function(err, val) {
            if(err) return t.fail("Error: " +  err);

            t.equal(val, 'kat');

            var secondCommit = uuid();

            db.put('cookie', 'cat', {commit: secondCommit, prev: firstCommit}, function(err) {
                if(err) return t.fail("Error: " + err);

                var thirdCommit = uuid();

                db.put('foo', 'bar', {commit: thirdCommit, prev: secondCommit}, function(err) {
                    if(err) return t.fail("Error: " + err);
                    
                    db.get('cookie', {commit: thirdCommit}, function(err, val) {
                        if(err) return t.fail("Error: " + err);
                        
                        t.equal(val, 'cat');
                        
                        db.get('cookie', {commit: firstCommit}, function(err, val) {
                        if(err) return t.fail("Error: " + err);
                            
                            t.equal(val, 'kat');

                            var fourthCommit = uuid();

                            // omit prev on purpose and see if it fails
                            db.put('cookie', 'cutter', {commit: fourthCommit}, function(err, val) {                           
                                t.equal(err instanceof Error, true);

                                // use wrong prev on purpose and see if it fails
                                db.put('cookie', 'cutter', {commit: fourthCommit, prev: "foo"}, function(err, val) {                           
                                    t.equal(err instanceof Error, true);
                                    
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});
