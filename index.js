var util = require('util');
var path = require('path');
var crypto = require('crypto');
var xtend = require('xtend');
var levelup = require('levelup');
var leveldown; // only required if needed
var defaults = require('levelup-defaults');
var bytewise = require('bytewise');
var sublevel = require('subleveldown');
var fse = require('fs-extra');
var uuid = require('uuid').v4;
var through = require('through2');
var commitdb = require('commitdb');
var AbstractLevelDOWN = require('abstract-leveldown').AbstractLevelDOWN;

function PastLevel(locationOrDB, opts) {
    if(!(this instanceof PastLevel)) return new PastLevel(locationOrDB, opts);
    
    opts = xtend({
        auto: true,
        multidb: false,
        multiclient: false,
        debug: false
    }, opts);
    this.opts = opts;

    if(opts.multidb) {
        throw new Error("fastcommit not implemented");
    }

    if(opts.multiclient && !opts.auto) {
        throw new Error("Manual mode not supported when multi is enabled");
    }

    if(opts.multidb && typeof locationOrDB !== 'string') {
        throw new Error("First argument must be a directory path if multidb is set to true");
    }

    this._dbOpts = {
        keyEncoding: bytewise, 
        valueEncoding: 'json'
    };

    this.workIndex = null;

    // these two are only used for multidb
    this._idb = null; // the currently opened index database
    this._multiPath = null; // base filesystem path to where databases are stored

    if(typeof locationOrDB === 'string') {
        AbstractLevelDOWN.call(this, locationOrDB);
        if(opts.multidb) {
            this._multiPath = locationOrDb;
            locationOrDB = path.join(locationOrDB, 'main');
        }
        leveldown = require('leveldown');
        this.db = require('level')(locationOrDB, this._dbOpts);
    } else if(locationOrDB && locationOrDB.location) {
        AbstractLevelDOWN.call(this, this.db.location);
        this.db = defaults(locationOrDB, this._dbOpts);
    } else {
        throw new Error("constructor requires a single argument: either a filesystem location for the db or an existing db instance");
    }

}

util.inherits(PastLevel, AbstractLevelDOWN);

PastLevel.prototype._open = function(opts, cb) {

    var self = this;

    function opened(err) {
        if(err) return cb(err)

        self._ops = []; // queued database operations
        self._iops = {}; // queued database operations for indexes (multidb only)

        self.cdb = commitdb(self.db, {prefix: 'commit'});

        if(self.opts.auto) {
            // in auto mode
            // generate the id for the next index
            // but don't add any data yet
            // and don't save
            self.workIndex = uuid(); 
        }

        if(self.opts.multiclient) {
            // don't check out when using multiclient
            return cb();
        }

        self._checkoutOnly(function(err, id) {
            if(err) return cb(err);
            

            if(self.opts.auto) {
                return cb();
            }
            
            // check if we have a working index
            self._getWorkIndex(function(err, id) {
                if(err) return cb(err);
                
                if(!id) {
                    // no working index so create one
                    self._createWorkIndex(function(err) {
                        if(err) return cb(err);
                        cb();
                    });
                } else {
                    cb();
                }
            });
        });
    }

    if(this.db.isOpen()) {
        return opened()
    }

    // calling .open actually calls ._open
    this.db.on('open', this.open.bind(this, opts, cb));
};

// create a new working index
PastLevel.prototype._createWorkIndex = function(cb) {
    var self = this;
    var id = uuid()

    // if a commit has not been checked out, create an empty index
    if(!this.cdb.cur) {
        this._saveWorkIndex(id, cb);
        return;
    }

    this._copyIndex(this.cdb.cur, id, function(err) {
        if(err) return cb(err);

        self._saveWorkIndex(id, cb);
    });
}

// save a reference to the current work index
PastLevel.prototype._saveWorkIndex = function(id, cb) {
    var self = this;
    this.db.put(['work-index'], id, function(err) {
        if(err) return cb(err);
        
        self.workIndex = id
        cb(null, id);
    });
};

// check if there is a saved work index
PastLevel.prototype._getWorkIndex = function(cb) {
    var self = this;
    this.db.get(['work-index'], function(err, id) {
        if(err) {
            if(err.notFound) return cb(null, null);
            return cb(err);
        }
        self.workIndex = id;
        cb(null, id);
    });
};

// get the key for the data "sublevel"
PastLevel.prototype._dkey = function(key) {
    return ['data', key];
};

// get the actual key for the current writing index
PastLevel.prototype._ikeyWrite = function(key, index) {
    return ['index', index || this.workIndex, key];
};

// get the actual key for the current reading index
PastLevel.prototype._ikeyRead = function(key, index) {
    if(this.opts.auto) {
        return ['index', index || this.cdb.cur || '', key];
    } else {
        return ['index', index || this.workIndex, key];
    }
};
 
PastLevel.prototype._dput = function(key, value, cb) {
    key = this._dkey(key);
    if(!cb) {
        this._ops.push({type: 'put', key: key, value: value});
        return
    }
    this.db.put(key, value, cb);
};
PastLevel.prototype._iput = function(key, value, cb) {
    key = this._ikeyWrite(key);
    if(this.opts.debug) console.log("[DEBUG] Putting to:", key);

    if(!cb) {
        this._ops.push({type: 'put', key: key, value: value});
        return;
    }
    if(this.opts.multidb) {
        
    } else {
        this.db.put(key, value, cb);
    }
};

PastLevel.prototype._ddel = function(key, cb) {
    key = this._dkey(key);
    if(!cb) {
        this._ops.push({type: 'del', key: key});
        return;
    }
    this.db.del(key, cb);
};
PastLevel.prototype._idel = function(key, cb) {
    key = this._ikeyWrite(key);
    if(!cb) {
        this._ops.push({type: 'del', key: key});
        return;
    }
    this.db.del(key, cb);
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

PastLevel.prototype._del = function(key, opts, cb) {
    var self = this;

    if(!this.opts.auto) {
        this._idel(key);
        this.commit(cb);
        return;
    }

    this._copyIndex(this.cdb.cur, this.workIndex, function(err) {
        this._idel(key);
        this.commit(cb);
    });
};

PastLevel.prototype._put = function(key, value, opts, cb) {
    var self = this;

    if(!this.opts.auto) {
        this.__put(key, value, opts, function(err) {
            if(err) return cb(err);

            // we now have uncommited changes
            self._setUncommitted(true);

            // actually run the queued db queries as a batch
            self._flush(cb);
        });
        return;
    }

    this._copyIndex(this.cdb.cur, this.workIndex, function(err) {
        self.__put(key, value, opts, function(err) {
            if(err) return cb(err);

            self.commit(cb);
        });
    });
};

PastLevel.prototype.__put = function(key, value, opts, cb) {

    var h = crypto.createHash('sha256');
    h.update(value);
    var hash = h.digest('hex');

    this._dput(hash, value);
    this._iput(key, hash);
    cb();
};

PastLevel.prototype.checkout = function(id, opts, cb) {
    if(typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    if(this.opts.multiclient) {
        opts.remember = false;
    }

    if(this.opts.auto) return this.cdb.checkout(id, opts, cb);

    var self = this;

    this._uncommitted(function(err, haveUncommitted) {
        if(haveUncommitted) return cb(new Error("You have uncommitted changes. Either commit these changes or do a reset before checking out another commit."));
        
        self._checkoutOnly(id, opts, function(err, id) {
            if(err) return cb(err);

            // clear the old contents of the work index
            self._delIndex(self.workIndex, function(err) {
                if(err) return cb(err);

                self._copyIndex(id, self.workIndex, function(err) {
                    if(err) return cb(err);
                    
                    cb(null, id);
                });
            });
        });
    });
};

// just do a checkout on this.cdb 
// (and if multidb:true then open the index database)
PastLevel.prototype._checkoutOnly = function(id, opts, cb) {
    var self = this;

    this.cdb.checkout(id, opts, function(err, id) {
        if(err) return cb(err);

        if(!id || !self.opts.multidb || !self.opts.auto) return cb(null, id);

        // for multidb in auto mode we open the index
        self._openIndex(id, function(err) {
            if(err) return cb(err);
            cb(null, id);
        });
    });
};

PastLevel.prototype._openIndex = function(id, cb) {
    // TODO make subdirs to ensure we don't run into filesystem subdir limit
    var dbPath = path.join(this._multiPath, 'indexes', id);
    var db = levelup(dbPath, this._dbOpts, cb);
};

// same as "git reset --hard"
// but beware that any new rows added but uncommitted 
// will not be automatically deleted unless {clean: true} is set! 
// otherwise you must run .clean to delete potentially orphaned rows
PastLevel.prototype.reset = function(opts, cb) {
    if(this.opts.auto) return cb(); // not applicable in auto mode
    if(typeof opts === 'function') {
        cb = opts;
        opts = {};
    }

    opts = xtend({
        clean: false // if true, delete orphaned rows (slow)
    }, opts || {});

    var self = this;

    this._uncommitted(function(err, haveUncommitted) {
        if(!haveUncommitted) return cb(); // no uncommitted changes so do nothing
        
        // delete current work index
        self._delIndex(self.workIndex, function(err) {
            if(err) return cb(err);

            // re-create work index from last commit index
            self._copyIndex(self.cdb.cur, self.workIndex, function(err) {
                if(err) return cb(err);
                
                // we no longer have uncommitted data
                self._setUncommitted(false, {queue: false}, function(err) {
                    if(err) return cb(err);

                    if(!opts.clean) {
                        return cb();
                    }

                    self.clean(cb);
                });
            });
        });
    });
};

// remove all rows that are not referenced at any point in commit history
// this can occur if you do a .reset after adding new rows, 
// or if you delete a commit
PastLevel.prototype.clean = function(cb) {
    var self = this;

    var s = this.db.createKeyStream({
        gt: ['data', ''],
        lt: ['data', '\uffff']
    });

    var cleaned = 0;
    var keys = {};
    var count = 0;

    s.pipe(through.obj(function(key, enc, next) {
        keys[key] = true;
        count++;
        if(count < 10000) {
            return next();
        }

        // every 10000 rows run a clean
        // so we don't end up with millions of keys cached in ram
        self._clean(keys, function(err, removed) {
            if(err) return cb(err);

            cleaned += removed;
            keys = {};
            count = 0;
            next();
        });
    }));

    if(count) {
        this._clean(keys, function(err, removed) {
            if(err) return cb(err);

            cleaned += removed;
            cb(null, cleaned);
        });
        return;
    }
        
    cb(null, cleaned);
};

// remove any non-indexed (orphaned) rows in a set
// takes a hash of keys as input
PastLevel.prototype._clean = function(keys, cb) {
    var hasErrd = false
    function errOnce(err) {
        if(hasErrd) return;
        hasErrd = true;
        cb(err);
    }

    var s = this.db.createValueStream({
        gt: ['index', ''],
        lt: ['index', '\uffff']
    });
    
    var self = this;

    s.on('data', function(val) {
        if(hasErrd) return;
        
        delete keys[val];
    });

    s.on('end', function() {
        if(hasErrd) return;

        // delete all non-indexed (orphaned) rows
        var count = 0;
        var key;
        for(key in keys) {
            self._ddel(key);
            count++;
        }

        self._flush(function(err) {
            if(err) return cb(err);

            cb(null, count);
        });
    });
};

// do we have any uncommitted changes? (only applies when auto: false)
PastLevel.prototype._uncommitted = function(cb) {
    if(this.opts.auto) return cb(null, false);

    this.db.get(['uncommitted'], function(err, val) {
        if(err) {
            if(err.notFound) return cb(null, false);
            return cb(err);
        }

        if(val) {
            cb(null, true);
        } else {
            cb(null, false);
        }
    });
};

// set or unset that we have uncommitted changes (only applies when auto: false)
PastLevel.prototype._setUncommitted = function(val, opts, cb) {
    if(typeof opts === 'function') {
        cb = opts;
        opts = {};
    }

    opts = xtend({
        queue: true // if false then actually run queries now
    }, opts || {});

    if(this.opts.auto) return cb();

    var q = {type: 'put', key: ['uncommitted'], value: (val) ? true : false};
    
    if(opts.queue) {
        
        this._ops.push(q);

        if(typeof cb === 'function') cb();
        return;
    }

    this.db.batch([q], function(err) {
        if(err) return cb(err);
        
        cb();
    });
};

PastLevel.prototype.commit = function(meta, opts, cb) {
    if(typeof meta === 'function') {
        cb = meta
        meta = {};
        opts = {};
    } else if(typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
   
    meta = meta || {};

    var self = this;
    this.cdb.commit(meta, {
        id: this.workIndex,
        batchFunc: function(ops, opts, cb) {
            self._ops = self._ops.concat(ops);
            process.nextTick(cb);
    }}, function(err, id, doc) {

        if(!self.opts.auto) {
            self._setUncommitted(false);
        }

        self._flush(function(err) {
            if(err) return cb(err);

            if(self.opts.auto) {
                self.workIndex = uuid();
                cb(null, id);
                return;
            }

            self._createWorkIndex(function(err) {
                if(err) return cb(err);

                cb(null, id);
            });
        });
    });
};


// copy one index to a new index in batches
PastLevel.prototype._copyIndex = function(src, dst, cb) {
    var hasErrd = false
    function errOnce(err) {
        if(hasErrd) return;
        hasErrd = true;
        cb(err);
    }

    var s = this.db.createReadStream({
        gt: ['index', src, ''],
        lt: ['index', src, '\uffff']
    });
    
    var count = 0;
    var batchSize = 100;
    var batchOps;
    var ops = [];
    var self = this;

    s.on('data', function(data) {
        if(hasErrd) return;
        ops.push({type: 'put', key: ['index', dst, data.key[2]], value: data.value});
        count++;
        if(ops.length >= batchSize) {
            batchOps = ops;
            ops = [];
            self.db.batch(batchOps, function(err) {
                if(err) return errOnce(err);
            });
        }
    });

    s.on('end', function() {
        if(hasErrd) return;
        if(ops.length) {
            count += ops.length;
            self.db.batch(ops, function(err) {
                if(err) return errOnce(err);
                cb(null, count);
            });
        } else {
            cb(null, count);
        }
    });
};

// delete an index
PastLevel.prototype._delIndex = function(idx, cb) {
    var hasErrd = false
    function errOnce(err) {
        if(hasErrd) return;
        hasErrd = true;
        cb(err);
    }

    var s = this.db.createReadStream({
        gt: ['index', idx, ''],
        lt: ['index', idx, '\uffff']
    });
    
    var count = 0;
    var batchSize = 100;
    var batchOps;
    var ops = [];
    var self = this;

    s.on('data', function(data) {
        if(hasErrd) return;
        ops.push({type: 'del', key: ['index', idx, data.key[2]]});
        count++;
        if(ops.length >= batchSize) {
            batchOps = ops;
            ops = [];
            self.db.batch(batchOps, function(err) {
                if(err) return errOnce(err);
            });
        }
    });

    s.on('end', function() {
        if(hasErrd) return;
        if(ops.length) {
            count += ops.length;
            self.db.batch(ops, function(err) {
                if(err) return errOnce(err);
                cb(null, count);
            });
        } else {
            cb(null, count);
        }
    });
};

 
PastLevel.prototype._get = function (key, opts, cb) {
    key = this._ikeyRead(key);

    if(this.opts.debug) console.log("[DEBUG]: Getting from:", key);

    var self = this;
    this.db.get(key, function(err, val) {
        if(err) return cb(err);

        self.db.get(self._dkey(val), function(err, val) {
            if(err) return cb(err);

            cb(null, val);
        });
    });
};


module.exports = function(db, opts) {
    var past;

    function getPast(db, opts2) {
        past = new PastLevel(db, opts);
        return past;
    }

    opts = xtend({
        db: getPast
    }, opts || {});

    var up;

    if(db) {
        up = levelup(db, opts);
    } else {
        up = levelup(opts);
    }

    up.cur = function() {
        return past.cdb.cur || null;
    };

    up.checkout = function() {
        return past.checkout.apply(past, arguments);
    };

    up.commit = function() {
        return past.commit.apply(past, arguments);
    };


    return up;
}

