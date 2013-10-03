var fs = require('fs');
var docmark = require('./doc.js');

var files = ['example/simple/vars.js', 'example/simple/object.js', 'example/simple/number.js', 'example/simple/array.js'];

console.log("\n");
files.forEach(function (filename) {
	var docset = docmark('DocMark');
	docset.add(filename);
	console.log(filename + "\n" + Array(filename.length + 1).join("-"));
	console.log(JSON.stringify(docset.schemas(), null, '\t'));
	console.log("\n");
});

