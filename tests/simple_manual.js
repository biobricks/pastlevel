var test = require('tape');
var temp = require('temp').track();
var util = require('util');
var pastlevel = require('../index.js');

/*
  check that basic "change, commit, checkout"-functionality 
  is working in manual mode

  with autocommit off:
  put a row, 
  get the row again, 
  commit,
  get the row again, 
  change the row,
  get the row again,
  commit,
  get the row again,
  check out first commit,
  get the row again
*/

test('simple_manual', function(t) {

    var db = pastlevel(temp.mkdirSync(), {auto: false});

    t.plan(9);

    var firstID;

    db.put('cookie', 'kat', function(err) {
        if(err) return t.fail("Error: " + err);

        db.get('cookie', function(err, val) {
            if(err) return t.fail("Error: " +  err);

            t.equal(val, 'kat');
            
            db.commit(function(err, firstID) {
                if(err) return t.fail("Error: " +  err);

                t.equal(typeof firstID, 'string');

                db.get('cookie', function(err, val) {
                    if(err) return t.fail("Error: " +  err);
                    
                    t.equal(val, 'kat');
                    
                    db.put('cookie', 'cat', function(err) {
                        if(err) return t.fail("Error: " + err);
               
                        db.get('cookie', function(err, val) {
                            if(err) return t.fail("Error: " + err);

                            t.equal(val, 'cat');

                            db.commit(function(err, secondID) {
                                if(err) return t.fail("Error: " +  err);
                                
                                t.equal(typeof secondID, 'string');

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
            });
        });
    });
});
