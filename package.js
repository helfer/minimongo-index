Package.describe({
  name: 'helfer:minimongo-index',
  summary: "Add indexing to Meteor's minimongo",
  git: "https://github.com/helfer/minimongo-index",
  version: '0.0.1'
});

Package.onUse(function (api) {
  api.export('LocalCollection');
  api.export('IdMap');
  api.export('IdSet');
  api.export('Index');
  api.versionsFrom('1.1.0.2');
  api.use(['underscore', 'minimongo', 'ejson', 'id-map', 'ordered-dict']);
  api.addFiles([
    'minimongo-index.js',
    ]);

});

Package.onTest(function (api) {
  api.use('minimongo', 'client');
  api.use('helfer:minimongo-index', ['client', 'server']);
  api.use('test-helpers', 'client');
  api.use(['tinytest', 'underscore', 'ejson', 'ordered-dict',
           'random', 'tracker', 'reactive-var']);
  api.addFiles('minimongo-tests.js', 'client'); // the normal minimongo tests
  api.addFiles('minimongo-index-tests.js', 'client');
});
