#!/usr/bin/env nodejs

var util = require('util');
var pastlevel = require('../index.js');


var db = pastlevel('/tmp/pastlevel');

var firstID;

db.put('cookie', 'kat', function(err) {
    if(err) return console.error("Error:", err);
    
    console.log("put success with id:", db.cur());

    firstID = db.cur();

    db.get('cookie', function(err, val) {
        if(err) return console.error("Error:", err);

        console.log("got:", val);

        db.put('cookie', 'cat', function(err) {
            if(err) return console.error("Error:", err);
            
            console.log("put success with id:", db.cur());

            db.get('cookie', function(err, val) {
                if(err) return console.error("Error:", err);

                console.log("got:", val);

                db.checkout(firstID, function(err, id) {
                    if(err) return console.error("Error:", err);
                    
                    console.log("checked out id:", id);

                    db.get('cookie', function(err, val) {
                        if(err) return console.error("Error:", err);
                        
                        console.log("got:", val);
                    });
                });
            });
        });
    });
});


