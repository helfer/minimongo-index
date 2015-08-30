# helfer:minimongo-index

[![BuildStatus](https://travis-ci.org/helfer/minimongo-index.svg?branch=master)](https://travis-ci.org/helfer/minimongo-index)

This package is under development. Use at your own risk. If you run into
problems, please open an issue on github.

https://github.com/helfer/minimongo-index

Minimongo-index adds simple indices to minimongo that can be defined
as follows: YourCollection.\_collection.\_ensureIndex('fieldName').

To define an index on multiple fields, pass an array to ensureIndex.

Speeds up minimongo quite a bit if you have large collections, but the index is
not sorted, so it doesn't speed up sorting at all. It's really just intended for
indices based on object IDs.

Minimongo is used as a temporary data cache in the standard Meteor stack, to
learn more about mini-databases and what they can do, see [the project page on
www.meteor.com](https://www.meteor.com/mini-databases)


