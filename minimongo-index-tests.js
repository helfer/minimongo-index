Tinytest.add('IdSet - basic', function (test) {
    var ids = new IdSet();

    ids.add( '123' );
    test.equal( ids.values(), ['123'] );

    ids.remove('nonexistent');
    test.equal( ids.values(), ['123'] );

    ids.remove( '123' );
    test.equal( ids.values(), [] );

    ids.add('123');
    ids.add('234');
    ids.add('345');

    test.equal( ids.values(), ['123','234','345'] );
});

Tinytest.add('Index - basic (one key)', function (test) {
    var ix = new Index( 'name', [ 'name' ] );

    // test adding document without it. should do nothing
    ix.add( { name: 'one' } );
    test.equal( ix.getMatchingIds( { name: 'one' } ), [] );

    // test adding one to index
    ix.add( { _id:'1', name: 'one' } );
    test.equal( ix.getMatchingIds( { name: 'one' } ), [ '1' ] );

    // add another
    ix.add( {_id:'2', name: 'one' } );
    test.equal( ix.getMatchingIds( { name: 'one' } ), [ '1', '2' ] );

    // make sure null keys work appropriately
    ix.add( {_id:'3', noname: 'one' } );
    test.equal( ix.getMatchingIds( { name: 'one' } ), [ '1', '2' ] );
    test.equal( ix.getMatchingIds( { name: null } ), [ '3' ] );

    // make sure other key doesn't interfere
    ix.add( {_id:'4', name: 'two' } );
    test.equal( ix.getMatchingIds( { name: 'one' } ), [ '1', '2' ] );
    test.equal( ix.getMatchingIds( { name: 'two' } ), [ '4' ] );

    // make sure perhapsUpdate doesn't update if original doc doesn't exist
    ix.perhapsUpdate( {_id: '4', name:'one'}, {_id: '4', name: 'three'} );
    test.equal( ix.getMatchingIds( { name: 'one' } ), [ '1', '2' ] );
    test.equal( ix.getMatchingIds( { name: 'two' } ), [ '4' ] );

    // make sure perhapsUpdate updates
    ix.perhapsUpdate( {_id: '4', name:'one'}, {_id: '4', name: 'two'} );
    test.equal( ix.getMatchingIds( { name: 'one' } ), [ '1', '2', '4' ] );

    // test if removing works
    ix.remove( {_id:'2', name: 'one' } );
    ix.remove( {_id:'4', name: 'one' } );
    test.equal( ix.getMatchingIds( { name: 'one' } ), [ '1' ] );

    // removing again doesn't do anything
    ix.remove( {_id:'2', name: 'one' } );
    test.equal( ix.getMatchingIds( { name: 'one' } ), [ '1' ] );

    // empty array after removing last item
    ix.remove( { _id:'1', name: 'one' } );
    test.equal( ix.getMatchingIds( { name: 'one' } ), [ ] );
});

Tinytest.add('Index - selectorHasMatchingKeys()', function( test ){
    var ix = new Index( 'name', [ 'name' ] );

    // make sure selector checking works
    test.equal( ix.selectorHasMatchingKeys({name: 'same'}), true );
    test.equal( ix.selectorHasMatchingKeys({noname: 'different'}), false);

    test.equal( ix.selectorHasMatchingKeys( { name: { a: 'Donald Duck' } } ), true );
    test.equal( ix.selectorHasMatchingKeys( { name: { $lt: 45 } } ), false );

    // with two keys
    var ix = new Index( 'name_age', [ 'name', 'age' ] );

    // make sure selector checking works
    test.equal( ix.selectorHasMatchingKeys({name: 'same', age: '25' }), true );
    test.equal( ix.selectorHasMatchingKeys({name: null, age: '25' }), true );
    test.equal( ix.selectorHasMatchingKeys({name: 'same', age: null }), true );
    test.equal( ix.selectorHasMatchingKeys({name: null, age: null }), true );
    test.equal( ix.selectorHasMatchingKeys({name: undefined, age: undefined }), true );
    test.equal( ix.selectorHasMatchingKeys({name: undefined, age: { $in: [1,2,3] } }), false );

    test.equal( ix.selectorHasMatchingKeys({noname: 'different', age: '22' }), false);
    test.equal( ix.selectorHasMatchingKeys({name: 'same', noage: 'xx' }), false);
    test.equal( ix.selectorHasMatchingKeys({age: '22' }), false);
    test.equal( ix.selectorHasMatchingKeys({name: 'some' }), false);

});

Tinytest.add('Index - two keys', function (test) {
    var ix = new Index( 'name_age', [ 'name', 'age' ] );

    // test adding one document to index
    ix.add( {_id: '1', name: 'Anton', age:1 } );
    test.equal( ix.getMatchingIds( { name: 'Anton', age: 1 } ), ['1'] );
    test.equal( ix.getMatchingIds( { name: 'Anton', age: 2 } ), [] );
    test.equal( ix.getMatchingIds( { name: 'Nobody', age: 1 } ), [] );

    ix.add( {_id: '2', name: 'Brian' } );
    test.equal( ix.getMatchingIds( { name: 'Brian', age: null } ), ['2'] );
 });
