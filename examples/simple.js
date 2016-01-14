#!/usr/bin/env nodejs

var util = require('util');
var pastlevel = require('../index.js');


var db = pastlevel('/tmp/pastlevel');

db.put('cookie', 'cat', function(err) {
    if(err) return console.error("Error:", err);
    
    console.log("put success");

    db.get('cookie', function(err, val) {
        if(err) return console.error("Error:", err);

        console.log("got:", val);
    });
});


