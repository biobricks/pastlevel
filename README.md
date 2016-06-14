[![NPM][npm-img]][npm-url]
[![Build Status][ci-img]][ci-url]

NOTE: This module barely exists yet. Don't trust this documentation. Come back later. 

pastlevel is versioning for leveldb where an entire database is versioned. That means you can check out your leveldb database as it looked at any point in the past and it will act like a perfectly normal leveldb instance.

pastlevel is kinda like git, but for databases. 

# instantiate

pastlevel can use a single levelup database to store its data, or it can use multiple databases. Using multiple databases drastically speeds up commits for large datasets. See the performance section for more on this. 

## single db mode

Single db mode is the default. In this mode you can pass a file path or an existing levelup instance to pastlevel. If passing a filepath, the levelup database at that location will be created or opened. If you intend to pass a filepath then you must npm install leveldown. The leveldown module is part of the dev-dependencies but not the production dependencies.

```
# let pastlevel create the database
# remember to: npm install leveldown

var pastlevel = require('pastlevel');
var db = pastlevel('/tmp/my_database');
```

```
# using existing levelup instance

var pastlevel = require('pastlevel');
var levelup = require('levelup');

var ldb = levelup('/tmp/my_database');
var db = pastlevel(db);
```

## multi db mode

If you set {multidb: true} then the first argument must be a filesystem path that specifies where to store the databases. You must also manually npm install leveldown.

```
# remember to run: npm install leveldown
var pastlevel = require('pastlevel');
var db = pastlevel('/tmp/my_database', {multi: true});
```

## automatic mode

pastlevel can be used in automatic mode (the default) as if it was a perfectly normal leveldb instance. Every put, delete or batch operation will automatically result in a new revision and a second argument with the commit metadata will be passed to the callback:

```
var pastlevel = require('pastlevel');
var db = pastlevel('my_database');

db.put('cookie', 'kat', function(err, commit) {
  if(err) return console.error(err);

  console.log("first put created revision:", commit.id);

  db.put('cookie', 'cat', function(err, commit) {
    if(err) return console.error(err);

    console.log("second put created revision:", commit.id);
  });
});
```

## manual mode

If you initialize pastlevel with {auto: false} then you will have to manually call commit in order to commit your changes as a new revision:

```
var pastlevel = require('pastlevel');
var db = pastlevel('my_database', {auto: false});

db.put('cookie', 'kat', function(err, commit) {
  if(err) return console.error(err);

  console.log("no commit created yet:", commit);

  db.put('cookie', 'cat', function(err, commit) {
    if(err) return console.error(err);

    console.log("still no commit created:", commit);

    db.commit(function(err, commit) {
      if(err) return console.error(err);

      console.log("created new commit with id:", commit);
    });
  });
});
```

WARNING: Manual mode does not work correctly when there are multiple connections to the same database. Think of manual mode as a git-like mode where a replication (continous or manual) would take care of pushing the committed changes (replication is not part of commitdb).

## options

```
var db = pastlevel('my_database', {
  auto: true, // automatically commit on each put, del or batch
  multidb: true, // store each index in its own leveldb instance (see performance section)
  
});
```

# API

pastlevel uses commitdb and includes the [commitdb API](https://www.npmjs.com/package/commitdb) API. This means that you can use commitdb API functions such as e.g. .checkout, .prev or .prevStream directly on a pastlevel database. The functions that are different from commitdb are documented below:

## .put(key, value, [opts], cb)

Same syntax as .put from levelup. In auto mode it will automatically create a new commit with the currently checked out commit (if any) as parent and the new commit will become the checked out commit. 

The following additional opts are supported in auto mode:

* prev: Array of parent commit ID(s) for the commit. Specify multiple IDs in order to merge multiple parents.
* unify: Boolean. Set to true to merge all current heads. Equivalent to specifying an array of all current heads as opts.prev
* check: Boolean. Set to false to disable checking if prevs actually exist. Default is true.

## .del(key, [opts], cb) 

Same as .del from levelup but with differences shown in .put section further up on this page

## .batch(operations, [opts], cb)

Same as .batch from levelup but with differences shown in .put section further up on this page.

## .batch - chained form

Not yet implemented. ToDo.

## .get

Exactly the same API as levelup.

## .createReadStream, .createKeyStream and .createValueStream

Exactly the same API as levelup except for the following two points:

1: Unlike with a normal levelup database, if the data changes while the read stream is in progress then the stream will emit the changed data. In other words read streams will not be locked to a view of the database as it looked when the stream was started. This is unfortunately impossible to implement using the current available levelup/leveldown API. The upside is that this limitation is only relevant for pastlevel databases in manual mode since auto mode databases cannot experience changes that are not also new commits and read streams _will_ be locked to the current commit.

2: Even in manual mode you can get a read stream that is locked to a view at a particular commit by specifying the commit id as an opt:

```
var stream = db.createReadStream({id: 'my_commit_id'});
```

Note that, in manual mode, specifying the id of the currently checked out commit will give a read stream of the database as it looked when that commit was made, not the working index. There is no way to get a read stream that is locked to the working index in manual mode. 

## .close

Same as .close from levelup.

## .commit([meta], [opts], cb)

Only relevant in manual mode.

meta is an object you wish to attach as meta-data to the commit. This could be e.g. authorship information and timestamp. Don't confuse this metadata with the commitdb metadata. commitdb's metadata contains the data structures used to track version history and should not be tampered with directly.

The opts are the same as explained in the .put documentation further up on this page.

If the first argument is an object and the second is a function then the first argument is taken to be meta.

## .merge([meta], [opts], cb)

This is simply syntactic suger to make a commit that merges all heads. Same syntax as .commit otherwise.

## .cur() 

Return the id of the currently checked out commit (or null if nothing checked out).

## .checkout, .prev, .next, .prevStream, .nextStream, .headStream, .heads, .tails, .isFork, .isTail, .isHead, isMerge

All of these are the same as for [commitdb](https://github.com/biobricks/commitdb).

## .reset([opts], cb)

Remove all uncommited changes.

If `opts.clean` is set to false then any new keys added to the database will not be automatically removed but the reset operation will be faster. You can call .clean manually later if needed.

Similar to `git reset --hard`. Only applicable in manual mode. 

Not yet supported in multidb mode unless opts.clean is false.

## .clean([opts], cb)

Remove all keys (and their values) that are not referenced anywhere in the entire commit history. Only really useful in manual mode after `.reset({clean: false})`.

Not yet supported in multidb mode.

## explicitly specifying database

You can explicitly specify the database and thus use a levelup instance with a different backend:

```
var levelup = require('levelup');
var pastlevel = require('pastlevel');

var rawdb = levelup('my_database', {db: require('memdown')});
var db = pastlevel(rawdb);
```

However, if you do this then commits will take longer for large databases since a complete (and modified) copy of the previous database index has to be built using only the leveldb get/put/batch primitives. See the _performance_ section for more info.

# stateless operation

If you're planning on using pastlevel in a scenario where multiple users will be accessing the same pastlevel database then you should use `{stateless: true}` or you'll get in trouble fast. Manual mode will not work with stateless mode.

Normally when opening a pastlevel database, pastlevel will attempt to check out the previously checked out commit, but when stateless mode is enabled nothing will ever be checked out. Instead you will have to manually specify the commit id for the next commit, as well as the previous commit (parent commit in each call to .get, .del, .createReadStream, etc. by passing opts.commit set to the commit id you want to use for the operation.

Usage example:

```
var firstCommit = uuid(); // generate universally unique id for first commit

// first commit has prev set to null (not undefined nor false)
db.put('cookie', 'kat', {commit: firstCommit, prev: null}, function(err) {

  var secondCommit = uuid();
  db.put('cookie', 'cat', {commit: secondCommit, prev: firstCommit}, function(err) {
    db.get('cookie', {commit: secondCommit}, function(err, value) {

      console.log("cookie", value);
    });
  });
});
```

A couple of dangers: There is currently no verification that the commit ids are sane. As an example it's possible to use the same id as both commit and prev. This would break everything.

You can use the this syntax even if stateless operation is not turned on. It will take presedence over stateful operation so you can mix and match if needed.

# atomicity, frozen views and cleanup

Normal levelup has the following features:

* .put, .del and .batch are atomic
* read streams are locked to how the db looked when the stream started

In auto mode pastlevel provides both of these, except for the fact that if an operation that modifies the database is interrupted then unused indexes can be left behind indefinitely (taking up space). Hopefully this will be solved in a later version.

In manual mode .put, .del and .batch are fully atomic (but of course don't result in a commit) and .commit has the problem where it will leave behind unused indexes if interrupted before it completes.

# performance 

Most operations are pretty fast. A pastlevel .get, .put, del or .batch in manual mode is equivalent to two of the same leveldown operations. Even in auto mode .get is equivalent to two normal .get operations. The one slow part of pastlevel is commits for large datasets. For manual mode this means .commit, .merge and .checkout calls and for auto mode this means any operation that changes the database. See the sub-section on commit performance for more details.

## checkouts

Checkouts are equivalent to a single levelup .put operation in auto mode. In manual mode checkouts have the same speed as commits (since a working index is then created on checkout). In stateless modes checkouts don't work (they alway turn an error).

## commits

On each commit a new index of the entire database is created that represents the database at that revision.

If pastlevel is allowed to use its "one leveldb instance per index" approach by setting {multidb: true} (the default), then it will use the filesystem to copy the leveldb instance holding the index. If {multidb: false}, which it will be if you explicitly told pastlevel which leveldb instance to use, then a bunch of .batch operations will be used to copy the previous index into a new sub-database (like a sublevel) within the given leveldb instance.

Here is a comparison of commit speed without and with multi turned on:

```
number of rows | single-database | multi-database
---------------------------------------------------------------
            10 |                 |
           100 |                 |
         1,000 |                 | ToDo fill out the rest of this
        10,000 |                 |
       100,000 |  ~1.3 seconds   | 
     1,000,000 | ~11.3 seconds   | ~0.05 seconds
    10,000,000 |                 |
   100,000,000 |                 |
 1,000,000,000 |                 |
```

All performance tests were run on a i5-2520M 2.5GHz CPU and a reasonably fast SSD using nodejs v0.12.7 and level version 1.4.0 on a lubuntu 14.04 system with a 3.13.0 kernel.

The disadvantage of the multidb approach is that you don't get the full benefit of leveldb's built-in compression. Indexes won't be compressed very well, so each commit will take up more disk space.

```
TODO compare disk usage for single and multi
```

# multiple heads

pastlevel allows multiple heads. You never have to explicitly branch, just check out a previous commit and start changing it and merge when you want or never merge, it's up to you!

# implementation notes

pastlevel uses [commitdb](https://www.npmjs.com/package/commitdb) to track the version history and stores all the actual database entry for all revisions in one single leveldb database where the key is the hash of the value. This means that the same value is never stored twice and since leveldb already has built-in compression all data is stored in compressed form (unless you turn on multidb mode).

# ToDo

* auto-remove junk indexes on next commit

* add 100% atomic mode (no indexes left behind ever)

* add options to both commitdb and pastlevel to allow the information about current checkout and current work index, as well as the work index itself, to be saved to a different database (in which case it will be prefixed with the database's id). this will be important for multi-user operation.

* support atomic commits as an option (only additional change is that the copy operation needs to add all ops to this._ops instead of actually running them).

# copyright and license

Copyright 2015-2016 BioBricks Foundation

License is [AGPLv3](https://www.gnu.org/licenses/agpl-3.0.txt).

[ci-img]: https://travis-ci.org/biobricks/pastlevel.svg?branch=master
[ci-url]: https://travis-ci.org/biobricks/pastlevel
[npm-img]: https://nodei.co/npm/pastlevel.png
[npm-url]: https://nodei.co/npm/pastlevel/