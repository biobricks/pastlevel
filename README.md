
NOTE: This module barely exists yet. Come back later.

pastlevel is versioning for leveldb where an entire database is versioned. That means you can check out your leveldb database as it looked at any point in the past and it will act like a perfectly normal leveldb instance.

pastlevel is kinda like git, but for databases. 

# usage

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

## manual control

If you initialize pastlevel with {auto: false} then you will have to manually call commit in order to commit a new revision:

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
      
    });
  });
});
```

## options

```
var db = pastlevel('my_database', {
  auto: true, // automatically commit on each put, del or batch
  multi: true // store each index in its own leveldb instance (see performance section)
});
```

## API

The rest of the API is exactly the same as the [commitdb API](https://www.npmjs.com/package/commitdb).

## explicitly specifying database

You can explicitly specify the database and thus use a levelup instance with a different backend:

```
var levelup = require('levelup');
var pastlevel = require('pastlevel');

var rawdb = levelup('my_database', {db: require('memdown')});
var db = pastlevel(rawdb);
```

However, if you do this then commits will take longer for large databases since a complete (and modified) copy of the previous database index has to be built using only the leveldb get/put/batch primitives. See the _performance_ section for more info.

# performance 

On each commit a new index of the entire database is created that represents the database at that revision.

If pastlevel is allowed to use its "one leveldb instance per index" approach by setting {multidb: true} (the default), then it will use the filesystem to copy the leveldb instance holding the index. If {multidb: false}, which it will be if you explicitly told pastlevel which leveldb instance to use, then a bunch of .batch operations will be used to copy the previous index into a new subleveldown within the given leveldb instance.

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

# differences between pastlevel and git

pastlevel allows multiple heads. You never have to explicitly branch, just check out a previous commit and start changing it and merge when you want or never merge, it's up to you!

# implementation notes

pastlevel uses [commitdb](https://www.npmjs.com/package/commitdb) to track the version history and stores all the actual database entry for all revisions in one single leveldb database where the key is the hash of the value. This means that the same value is never stored twice and since leveldb already has built-in compression all data is stored in compressed form.

# ToDo

* add checks to see if a put already exists. don't commit if no change is made. have an option to disable this functionality

* add options to both commitdb and pastlevel to allow the information about current checkout and current work index, as well as the work index itself, to be saved to a different database (in which case it will be prefixed with the database's id). this will be important for multi-user operation.

* support atomic commits as an option (only additional change is that the copy operation needs to add all ops to this._ops instead of actually running them. atomic will only make sense in auto mode).

# copyright and license

Copyright 2015 BioBricks Foundation

License is [AGPLv3](https://www.gnu.org/licenses/agpl-3.0.txt).