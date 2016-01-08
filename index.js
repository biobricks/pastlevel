var util = require('util');
var levelup = require('levelup');
var crypto = require('crypto');
var xtend = require('xtend');
var defaults = require('levelup-defaults');
var bytewise = require('bytewise');
var sublevel = require('subleveldown');
var commitdb = require('commitdb');
var AbstractLevelDOWN = require('abstract-leveldown').AbstractLevelDOWN;

function PastLevel(locationOrDB, opts) {

    opts = xtend({
        auto: true,
        multi: false
    }, opts);

    if(opts.multi !== false) {
        throw new Error("opts.multi not yet implemented");
    }

    var dbOpts = {
        keyEncoding: bytewise, 
        valueEncoding: 'json'
    };

    if(typeof locationOrDB === 'string') {
        AbstractLevelDOWN.call(this, locationOrDB);
        this.db = levelup(locationOrDB, dbOpts);
    } else if(locationOrDB && locationOrDB.location) {
        AbstractLevelDOWN.call(this, this.db.location);
        this.db = defaults(locationOrDB, dbOpts);
    } else {
        throw new Error("constructor requires a single argument: either a filesystem location for the db or an existing db instance");
    }

}

PastLevel.prototype._open = function(options, callback) {
    function opened(err) {
        if(err) return callback(err)

        // initialize sublevels
        /*
        this.ddb = sublevel(this.db, 'data'); // actual rows
        this.cdb = commitdb(sublevel(this.db, 'commits')); // commit history
        this.idb = sublevel(this.db, 'index'); // the current index
        */
        this.cdb = commitdb(this.db, {prefix: 'commit'});

        this._ops = []; // queued database operations
    }

    if(this.db.isOpen()) {
        return opened()
    }

    // calling .open actually calls ._open
    this.db.on('open', this.open.bind(this, opts, opened));
};
 
PastLevel.prototype._dput = function(key, value) {
    this._ops.push({type: 'put', key: ['data', key], value: value});
};
PastLevel.prototype._iput = function(key, value) {
    this._ops.push({type: 'put', key: ['index', key], value: value});
};

PastLevel.prototype._ddel = function(key) {
    this._ops.push({type: 'del', key: ['data', key]});
};
PastLevel.prototype._idel = function(key) {
    this._ops.push({type: 'del', key: ['index', key]});
};

// actually run queued database operations
PastLevel.prototype._flush = function(cb) {
    var self = this;
    this.db.batch(this._ops, function(err) {
        if(err) return cb(err);
        self._ops = [];
        cb();
    });
};

/*
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
*/
PastLevel.prototype._put = function(key, value, opts, cb) {


    var h = crypto.createHash('sha256');
    h.update(value);
    var hash = h.digest('hex');

    this._dput(hash, value);
    this._iput(key, hash);
    this.commit(cb);
}


PastLevel.prototype.commit = function(opts, cb) {
    if(typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    
    var self = this;
    this.commitdb.commit({
        author: "Foobar"
    }, {batchFunc: function(ops, cb) {
        self.db.batch(ops, cb);
    }, function(err, key, doc) {
        self._flush(function(err) {
            if(err) return cb(err);
            cb(null, key);
        });
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

