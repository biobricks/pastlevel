var util = require('util');
var levelup = require('levelup');
var uuid = require('uuid').v4;
var xtend = require('xtend');
var sublevel = require('subleveldown');
var commitdb = require('commitdb');
var AbstractLevelDOWN = require('abstract-leveldown').AbstractLevelDOWN;

function PastLevel(locationOrDB) {

    if(typeof locationOrDB === 'string') {
        AbstractLevelDOWN.call(this, locationOrDB);
        this.db = levelup(locationOrDB);
    } else if(locationOrDB && locationOrDB.location) {
        AbstractLevelDOWN.call(this, this.db.location);
        this.db = locationOrDB;
    } else {
        throw new Error("constructor requires a single argument: either a filesystem location for the db or an existing db instance");
    }

}

PastLevel.prototype._open = function(options, callback) {
    function opened(err) {
        if(err) return callback(err)

        // initialize sublevels
        this.data = sublevel(this.db, 'd'); // actual rows
        this.commits = commitdb(sublevel(this.db, 'c')); // commit history
    }

    if(this.db.isOpen()) {
        return opened()
    }

    // calling .open actually calls ._open
    this.db.on('open', this.open.bind(this, opts, opened));
}
 
// store data under a unique key, returning the generated key
PastLevel.prototype._putData = function(value, callback) {
    var key = uuid();
    this.data.put(key, value, function(err) {
        if(err) return callback(err);
        callback(null, key);
    });
}

// generate and store a commit
PastLevel.prototype._makeCommit = function(prev, key, value, callback) {
    this.commits.create({
        key: uuid(),
        prev: prev,
    }, function(err) {
        if(err) return callback(err);
        callback(null, key);
    });
}

PastLevel.prototype._put = function(key, value, options, callback) {

    this.putData(value, function(err, dkey) {
        if(err) return callback(err);
        
        
    });
}
 
PastLevel.prototype._get = function (key, options, callback) {
  var value = this._store['_' + key]
  if (value === undefined) {
    // 'NotFound' error, consistent with LevelDOWN API 
    return process.nextTick(function () { callback(new Error('NotFound')) })
  }
  process.nextTick(function () {
    callback(null, value)
  })
}
 
PastLevel.prototype._del = function (key, options, callback) {
  delete this._store['_' + key]
  process.nextTick(callback)
}


util.inherits(PastLevel, AbstractLevelDOWN);


module.exports = function(db, opts) {
    opts = xtend({
        db: new PastLevel(db, opts)
    }, opts || {});
    
  return levelup(opts);
}

