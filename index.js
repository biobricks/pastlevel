/*

  TODO: Don't use this.cdb.cur ever. 
        On commit it gets changed before ops are flushed.
        Swap everything to using this.cdbCur instead

  TODO: Ensure that global vars are all changed on same tick:
          this.cdbCur
          this.workIndex
          this._idb
          
  TODO: In stateless mode check that commit indexes aren't re-used (user error) which would break everything.

  TODO: Multidb doesn't work with stateless. Fix this.        

  Auto:
    reading form this.cdb.cur
    writing to workIndex
    on put/del/batch:
      copy index
      open workIndex
      write to workIndex
  
  Manual:
    read/write workIndex
    on put/del/batch

  TODO: 

  * multidb support for:
  ** all the index put, del and batch functions
  ** the flush function

*/

var util = require('util');
var path = require('path');
var crypto = require('crypto');
var xtend = require('xtend');
var levelup = require('levelup');
var leveldown; // only require()'d if needed
var defaults = require('levelup-defaults');
var bytewise = require('bytewise');
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
        stateless: false,
        debug: false
    }, opts);
    this.opts = opts;

    if(opts.stateless && !opts.auto) {
        throw new Error("Manual mode not supported when stateless is enabled");
    }

    if(opts.multidb && typeof locationOrDB !== 'string') {
        throw new Error("First argument must be a directory path if multidb is set to true");
    }

    this._dbOpts = {
        keyEncoding: bytewise, 
        valueEncoding: 'json'
    };

    this.workIndex = null; // next commid id (used for next commit)
    this.cdbCur = null; // currently checked out commit id

    // these two are only used for multidb
    this._idb = null; // the current index database
    this._idbWrite = null; // the current index database for writing
    this._multiPath = null; // base filesystem path to where databases are stored

    if(typeof locationOrDB === 'string') {
        AbstractLevelDOWN.call(this, locationOrDB);
        if(opts.multidb) {
            this._multiPath = locationOrDB;
            locationOrDB = path.join(locationOrDB, 'main');
        }
        // levelup auto-includes leveldown if you have it installed
        this.db = levelup(locationOrDB, this._dbOpts);
    } else if(locationOrDB && locationOrDB.location) {
        AbstractLevelDOWN.call(this, locationOrDB.location);
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
        self._iops = []; // queued database operations for indexes (multidb only)

        self.cdb = commitdb(self.db, {prefix: 'commit'});

        if(self.opts.auto) {
            // in auto mode
            // generate the id for the next index
            // but don't add any data yet
            // and don't save
            self.workIndex = uuid(); 
        }

        if(self.opts.stateless) {
            // don't check out when using stateless mode
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

        self.workIndex = id;        

        self._openIdb(id, function(err) {
            cb(null, id);
        });
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
        self._openIdb(id, function(err) {
            cb(null, id);
        });
    });
};

// get the key for the data "sublevel"
PastLevel.prototype._dkey = function(key) {
    return ['data', key];
};

// get the actual key for the current writing index
PastLevel.prototype._ikeyWrite = function(key, index) {
    if(this.opts.multidb) {
        return key;
    }
    return ['index', index || this.workIndex, key];
};

// get the actual key for the current reading index
PastLevel.prototype._ikeyRead = function(key, index) {
    if(this.opts.multidb) {
        return key;
    }
    if(this.opts.auto) {
        return ['index', index || this.cdbCur, key];
    } else {
        return ['index', index || this.workIndex, key];
    }
};
 
PastLevel.prototype._dput = function(key, value, cb) {
    key = this._dkey(key);
    if(this.opts.debug) console.log("[DEBUG] Putting to key:", key, value);
    if(!cb) {
        this._ops.push({type: 'put', key: key, value: value});
        return
    }
    this.db.put(key, value, cb);
};
PastLevel.prototype._iput = function(key, value, opts) {
    key = this._ikeyWrite(key, opts.commit);
    if(this.opts.debug && !this.opts.multidb) console.log("[DEBUG] Putting to key:", key, value);

    if(this.opts.multidb) {
        if(this.opts.debug) console.log("[DEBUG] Putting to key:", key, "in db:", this.workIndex, value);
        this._iops.push({type: 'put', key: key, value: value});
    } else {
        this._ops.push({type: 'put', key: key, value: value});            
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

PastLevel.prototype._idel = function(key, opts) {
    key = this._ikeyWrite(key, opts.commit);

    if(this.opts.multidb) {
        this._iops.push({type: 'del', key: key});
    } else {
        this._ops.push({type: 'del', key: key});
    }
};

// actually run queued database operations
PastLevel.prototype._flush = function(cb) {
    var self = this;

    this._iflush(function(err) {
        if(err) return cb(err);

        if(self.opts.debug > 1) {
            console.log("[DEBUG] Flushing to main db:", self._ops);
        }

        self.db.batch(self._ops, function(err) {
            if(err) return cb(err);
            self._ops = [];
            cb();
        });
    });
};

// get the commit id for an index db (multidb mode)
PastLevel.prototype._dbName = function(db) {
    var s = db.location.match(/\/indexes\/(.*)/)[1].replace(/\//g, '');
    return s.slice(0, 8)+'-'+s.slice(8, 12)+'-'+s.slice(12, 16)+'-'+s.slice(16, 20)+'-'+s.slice(20);
};

// if multidb, flush operations to index database
PastLevel.prototype._iflush = function(cb) {
    if(!this.opts.multidb) return cb();

    var db;
    if(this.opts.auto) {
        db = this._idbWrite;
    } else {
        db = this._idb;
    }

    if(this.opts.debug > 1) {
        console.log("[DEBUG] Flushing to index db", this._dbName(db) + ': ', self._ops);
    }

    db.batch(this._iops, function(err) {
         if(err) return cb(err);
        self._iops = [];
        cb();
    });    
};

// TODO finish and test this
PastLevel.prototype._del = function(key, opts, cb) {
    var self = this;

    if(this.opts.stateless) {
        if(!opts.commit) {
            return cb("opts.commit is required for stateless operation");
        };
        if(!opts.prev) {
            opts.prev = null;
        }
    }

    if(!this.opts.auto) {
        this._idel(key, opts);

        // we now have uncommited changes
        self._setUncommitted(true);

        // actually run the queued db queries as a batch
        self._flush(cb);
    }

    this._preCommitCopyIndex((opts.prev !== undefined) ? opts.prev : this.cdb.cur, opts.commit || this.workIndex, function(err) {
        if(err) return cb(err);

        self._idel(key, opts);
        self.commit({}, {commit: opts.commit, prev: opts.prev}, cb);
    });

};

PastLevel.prototype._put = function(key, value, opts, cb) {
    var self = this;

    if(this.opts.stateless) {
        if(!opts.commit) {
            return cb("opts.commit is required for stateless operation");
        };
        if(!opts.prev) {
            opts.prev = null;
        }
    }

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

    this._preCommitCopyIndex((opts.prev !== undefined) ? opts.prev : this.cdb.cur, opts.commit || this.workIndex, function(err) {
        if(err) return cb(err);

        self.__put(key, value, opts, function(err) {
            if(err) return cb(err);

            self.commit({}, {commit: opts.commit, prev: opts.prev}, cb);
        });
    });
};

PastLevel.prototype.__put = function(key, value, opts, cb) {

    var h = crypto.createHash('sha256');
    h.update(value);
    var hash = h.digest('hex');

    this._dput(hash, value);
    this._iput(key, hash, opts);
    cb();
};

PastLevel.prototype.checkout = function(id, opts, cb) {
    if(typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    if(this.opts.stateless) {
        return cb("checkout makes no sense in stateless mode");
//        opts.remember = false;
    }

    var self = this;

    if(this.opts.auto) {
        this._checkoutOnly(id, opts, function(err, id) {
            if(err) return cb(err);
            self.cdbCur = id;
            cb(null, id);
        });
        return;
    }

    this._uncommitted(function(err, haveUncommitted) {
        if(haveUncommitted) return cb(new Error("You have uncommitted changes. Either commit these changes or do a reset before checking out another commit."));
        
        self._checkoutOnly(id, opts, function(err, id) {
            if(err) return cb(err);

            // clear the old contents of the work index
            self._delIndex(self.workIndex, function(err) {
                if(err) return cb(err);

                self._copyIndex(id, self.workIndex, function(err) {
                    if(err) return cb(err);

                    self.cdbCur = id;                    
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

        if(!id) return cb(null, null);

        self._openIdb(id, function(err) {
            if(err) return cb(err);

            cb(null, id);
        });
    });
};

PastLevel.prototype._indexPath = function(id) {
    if(id.length !== 36) throw new Error("misformed id")

    // split id into an array of 4 char elements
    // and create 8 levels of subdirs to overcome
    // filesystem limits on maximum subdirs (64000 for ext4)
    var parts = id.replace(/-/g, '').match(/.{4}/g);
    parts = path.join.apply(path.join, parts);

    return path.join(this._multiPath, 'indexes', parts);
};


PastLevel.prototype._openIdb = function(id, opts, cb) {
    if(typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    var self = this;

    if(!this.opts.multidb) return cb(null);

    var dbPath = this._indexPath(id);

    this._closeIfOpen(this._idb, function(err) {
        if(err) return cb(err);

        self._levelup(dbPath, self._dbOpts, function(err, db) {
            if(err) return cb(err);
            
            self._idb = db;
            cb(null, db);
        });
    });
};

// like normal levelup instantiation
// but ensures that parent dirs exist
PastLevel.prototype._levelup = function(dbPath, opts, cb) {
    fse.mkdirp(path.dirname(dbPath), function(err) {
        if(err) return cb(err);

        levelup(dbPath, opts, cb);
    });
};

PastLevel.prototype._openIndex = function(id, opts, cb) {
    if(typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    var self = this;

    if(!this.opts.multidb) return cb();

    var dbPath = this._indexPath(id);
    self._levelup(dbPath, self._dbOpts, cb);
};


PastLevel.prototype._closeIfOpen = function(db, cb) {
    if(!db || !db.isOpen()) {
        return cb();
    }
    db.close(cb);    
}

// same as "git reset --hard"
// but beware that any new rows added but uncommitted 
// will not be automatically deleted if {clean: false} is set! 
// otherwise you must run .clean to delete potentially orphaned rows
PastLevel.prototype.reset = function(opts, cb) {
    if(this.opts.auto) return cb(); // not applicable in auto mode
    if(typeof opts === 'function') {
        cb = opts;
        opts = {};
    }

    opts = xtend({
        clean: true // if true, delete orphaned rows (slow)
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


/*
  TODO alternate to .clean: 

    Instead of having to run clean an autoclean option
    could keep an index of "stuff to delete on .reset"
    by doing a get for each new inserted row to see if it already
    exists, and if it doesn't then add it to the "stuff to delete on .reset"-index
*/

// remove all rows that are not referenced at any point in commit history
// this can occur if you do a .reset after adding new rows, 
// or if you delete a commit
PastLevel.prototype.clean = function(cb) {
    // TODO support multi mode
    if(this.opts.multidb) throw new Error("clean not supported in multi mode");

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

// TODO make _commit that's called internally
// and give error if commit called when in auto mode
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
        id: opts.commit || this.workIndex,
        prev: opts.prev,
        batchFunc: function(ops, opts, cb) {
            self._ops = self._ops.concat(ops);
            process.nextTick(cb);
    }}, function(err, id, doc) {
        if(err) return cb(err);

        if(!self.opts.auto) {
            self._setUncommitted(false);
        }

        self._flush(function(err) {
            if(err) return cb(err);

            if(self.opts.auto) {
                if(!self.opts.multidb) {
                    self.cdbCur = id;
                    self.workIndex = uuid();
                    cb(null, id);
                    return;
                }

                // close the current index db and start using the new 
                self._closeIfOpen(self._idb, function(err) {
                    if(err) return cb(err);

                    self.cdbCur = id;
                    self.workIndex = uuid();
                    self._idb = self._idbWrite;
                    self._idbWrite = null;
                    cb(null, id);
                }); 
                return;
            }

            self._createWorkIndex(function(err) {
                if(err) return cb(err);

                cb(null, id);
            });
        });
    });
};


PastLevel.prototype._preCommitCopyIndex = function(src, dst, cb) {
    self = this;

    if(this.opts.debug) {
        console.log('[DEBUG] Copying index from', src, 'to', dst);
    }
    

    this._copyIndex(src, dst, function(err) {
        if(err) return cb(err);
        
        if(!self.opts.multidb) return cb();
  
        self._openIndex(dst, self._dbOpts, function(err, db) {
            if(err) return cb(err);
            
            self._idbWrite = db;
            cb();
        })
    });
};

// copy one index to a new index in batches
PastLevel.prototype._copyIndex = function(src, dst, cb) {
    if(this.opts.multidb) return this._copyIndexMulti(src, dst, cb);

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
    
    var batchSize = 100;
    var batchOps;
    var ops = [];
    var self = this;

    s.on('data', function(data) {
        if(hasErrd) return;
        ops.push({type: 'put', key: ['index', dst, data.key[2]], value: data.value});
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
            self.db.batch(ops, function(err) {
                if(err) return errOnce(err);
                cb(null);
            });
        } else {
            cb(null);
        }
    });
};

PastLevel.prototype._copyIndexMulti = function(src, dst, cb) {
    if(!src) return cb();
    // convert index ids to paths
    src = this._indexPath(src);
    dst = this._indexPath(dst);

    fse.copy(src, dst, cb)
};

// delete an index
PastLevel.prototype._delIndex = function(idx, cb) {
    if(this.opts.multidb) return this._delIndexMulti(src, dst, cb);

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
    
    var batchSize = 100;
    var batchOps;
    var ops = [];
    var self = this;

    s.on('data', function(data) {
        if(hasErrd) return;
        ops.push({type: 'del', key: ['index', idx, data.key[2]]});
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
            self.db.batch(ops, function(err) {
                if(err) return errOnce(err);
                cb(null);
            });
        } else {
            cb(null);
        }
    });
};

PastLevel.prototype._delIndexMulti = function(id, cb) {
    // convert index ids to paths
    var iPath = this._indexPath(id);

    // TODO remove parent dirs if they are empty
    fse.remove(iPath, cb);
};
 
PastLevel.prototype._get = function (key, opts, cb) {

    if(this.opts.stateless && !opts.commit) {
        return cb("opts.commit is required for stateless operation");
    }

    key = this._ikeyRead(key, opts.commit);
    var db;
    if(this.opts.multidb) {
        if(this.opts.debug) console.log("[DEBUG]: Getting from key:", key, "in db:", this.cdb.cur, this._dbName(this._idb));
        db = this._idb;
    } else {
        if(this.opts.debug) console.log("[DEBUG]: Getting from key:", key);
        db = this.db;
    }

    var self = this;
    db.get(key, function(err, val) {
        if(err) return cb(err);

        self.db.get(self._dkey(val), function(err, val) {
            if(err) return cb(err);

            cb(null, val);
        });
    });
};


PastLevel.prototype.merge = function() {
    if(!this.cdb) return;
    this.cdb.merge.apply(this.cdb, arguments);
};

PastLevel.prototype.prev = function() {
    if(!this.cdb) return;
    this.cdb.prev.apply(this.cdb, arguments);
};

PastLevel.prototype.next = function() {
    if(!this.cdb) return;
    this.cdb.next.apply(this.cdb, arguments);
};

PastLevel.prototype.prevStream = function() {
    if(!this.cdb) return;
    this.cdb.prevStream.apply(this.cdb, arguments);
};

PastLevel.prototype.nextStream = function() {
    if(!this.cdb) return;
    this.cdb.nextStream.apply(this.cdb, arguments);
};

PastLevel.prototype.headStream = function() {
    if(!this.cdb) return;
    this.cdb.headStream.apply(this.cdb, arguments);
};

PastLevel.prototype.heads = function() {
    if(!this.cdb) return;
    this.cdb.heads.apply(this.cdb, arguments);
};

PastLevel.prototype.tail = function() {
    if(!this.cdb) return;
    this.cdb.tail.apply(this.cdb, arguments);
};

PastLevel.prototype.isFork = function() {
    if(!this.cdb) return;
    this.cdb.isFork.apply(this.cdb, arguments);
};

PastLevel.prototype.isTail = function() {
    if(!this.cdb) return;
    this.cdb.isTail.apply(this.cdb, arguments);
};

PastLevel.prototype.isHead = function() {
    if(!this.cdb) return;
    this.cdb.isHead.apply(this.cdb, arguments);
};

PastLevel.prototype.isMerge = function() {
    if(!this.cdb) return;
    this.cdb.isMerge.apply(this.cdb, arguments);
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

    var up = levelup(db, opts);

    up.cur = function() {
        if(past.opts.stateless) {
            return null;
        } else {
            return past.cdbCur || null;
        }
    };

    // methods to include from pastdb
    var pdbMethods = ['checkout', 'commit', 'merge', 'prev', 'next', 'prevStream', 'nextStream', 'headStream', 'heads', 'tail', 'isFork', 'isTail', 'isHead', 'isMerge'];

    var i;
    for(i=0; i < pdbMethods.length; i++) {
        up[pdbMethods[i]] = past[pdbMethods[i]].bind(past);
    }

    return up;
}

