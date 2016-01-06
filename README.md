
NOTE: This module barely exists yet. Come back later.

pastlevel is versioning for leveldb where an entire database is versioned. That means you can check out your leveldb database as it looked at any point in the past and it will act like a perfectly normal leveldb instance.

pastlevel is kinda like git, but for databases. 

# usage

```

```

# differences from git

pastlevel allows multiple heads. You never have to explicitly branch, just check out a previous commit and start changing it and merge when you want or never merge, it's up to you!

# implementation notes

pastlevel uses [commitdb](https://www.npmjs.com/package/commitdb) to track the version history and stores all the actual database entry for all revisions in one single leveldb database where the key is the hash of the value. This means that the same value is never stored twice and since leveldb already has built-in compression all data is stored in compressed form.

# copyright and license

Copyright 2015 BioBricks Foundation

License is [AGPLv3](https://www.gnu.org/licenses/agpl-3.0.txt).