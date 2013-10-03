var fs = require('fs');
var esprima = require('esprima');
var jsonPointer = require('json-pointer');

var jsSchema = require('./js-schema');

// Very naive, unstructured recursion through the AST
function astSubNodes(ast, callback, pointer, nodeHistory) {
	pointer = pointer || "";
	nodeHistory = nodeHistory || [];
	var subNodeHistory = nodeHistory.concat([ast]);
	for (var key in ast) {
		var keyPointer = pointer + "/" + jsonPointer.escape(key);
		if (ast[key] && typeof ast[key] === 'object' && ast[key].type) {
			if (callback(ast[key], keyPointer, nodeHistory) !== false) {
				astSubNodes(ast[key], callback, keyPointer, subNodeHistory);
			}
		} else if (Array.isArray(ast[key])) {
			for (var i = 0; i < ast[key].length; i++) {
				if (ast[key][i] && typeof ast[key][i] === 'object' && ast[key][i].type) {
					if (callback(ast[key][i], keyPointer + "/" + i, nodeHistory) !== false) {
						astSubNodes(ast[key][i], callback, keyPointer + "/" + i, subNodeHistory);
					}
				}
			}
		}
	}
}

/*
ClassSet: a collection of class definitions
{
	"new": [
		{
			"title": "params",
			"description": "Title (string), or object representing documentation title/description/etc.",
			"type": ["object", "string"],
			"properties": {
				"title": {"type": "string"}
			}
		}
	]
}
*/
function ClassSet(params) {
	if (!(this instanceof ClassSet)) {
		return new ClassSet(params);
	}
	params = params || {};
	if (typeof params == "string") {
		params = {title: params};
	}
	// a title for the collection/API
	this.title = params.title || "Generated Documentation";
	this.classes = [];
	this.globalScope = {};
	this.undeclaredGlobals = {};
}
ClassSet.prototype = {
	// export all the docs as JSON files (one per class)
	exportJson: function (directory) {
		throw new Error("Not implemented yet");
	},
	schemas: function () {
		var result = {};
		for (var key in this.globalScope) {
			result[key] = this.globalScope[key].schema;
		}
		return result;
	},
	// parse a JS file and add the definitions
	add: function (jsFile) {
		var data = fs.readFileSync(jsFile);
		var code = data.toString();
		var ast = esprima.parse(code, {
			comment: true,
			loc: true,
			range: true
		});
		// Stuff the comments into the AST as plain text
		function findAstNode(ast, comment, startLimit) {
			if (ast.range[1] < comment.range[0] || ast.range[0] > startLimit) {
				return null;
			}
			if (ast.range[0] > comment.range[1]) {
				return ast;
			}
			var earliestNode = null;
			astSubNodes(ast, function (astNode) {
				var node = findAstNode(astNode, comment, startLimit);
				if (node && (!earliestNode || node.range[0] < earliestNode.range[0])) {
					earliestNode = node;
					startLimit = node.range[0];
				}
			});
			if (!earliestNode || earliestNode.range[0] == ast.range[0]) {
				return ast;
			}
			return earliestNode;
		}
		var comments = ast.comments;
		delete ast.comments; // Otherwise it recurses into the comments array
		for (var i = 0; i < comments.length; i++) {
			var comment = comments[i];
			var node = findAstNode(ast, comment, ast.range[1]);
			if (node) {
				node.comments = ((node.comments || "") + "\n" + comment.value).trim();
			} else {
				console.log("Un-matched comment: " + comment.value);
			}
		}
		fs.writeFileSync(jsFile + '-ast.json', JSON.stringify(ast, null, '\t'));
		this.walkAst(ast, this.globalScope);
		fs.writeFileSync(jsFile + '-result.json', JSON.stringify(this, null, '\t'));
	},
	walkAst: function (ast, scope) {
		if (ast.type == 'Program') {
			this.walkFunctionBody(ast.body, scope);
		} else {
			throw new Error('Unknown AST type: ' + ast.type);
		}
	},
	walkFunctionBody: function (statements, scope) {
		// Fill scope from all variable and function declarations
		astSubNodes(statements, function (node) {
			if (node.type == 'Function' || node.type == 'FunctionDeclaration' || node.type == 'FunctionExpression' || node.type == 'ArrowExpression') {
				// Catch function definitions
				if (node.id) {
					var variableName = node.id.name;
					scope[variableName] = new jsSchema.Variable({type: 'function'}, node); // fill in later
				}
				return false;
			} else if (node.type == 'VariableDeclarator') {
				if (node.id.type !== 'Identifier') {
					throw new Error('Destructured assignment not supported');
				}
				var variableName = node.id.name;
				scope[variableName] = new jsSchema.Variable({title: variableName}, node);
			}
		});
		statements = Array.isArray(statements) ? statements : [statements];
		for (var i = 0; i < statements.length; i++) {
			this.walkStatement(statements[i], scope);
		}
	},
	walkStatement: function (statement, scope) {
		if (statement.type == 'EmptyStatement') {
			// Nothing to do
		} else if (statement.type == 'BlockStatement') {
			for (var i = 0; i < statement.body.length; i++) {
				this.walkStatement(statement.body[i], scope);
			}
		} else if (statement.type == 'VariableDeclaration') {
			for (var i = 0; i < statement.declarations.length; i++) {
				var declaration = statement.declarations[i];
				if (declaration.id.type !== 'Identifier') {
					throw new Error('Destructured assignment not supported');
				}
				var variableName = declaration.id.name;
				var variableSchema = scope[variableName];
				if (declaration.init) {
					scope[variableName].setSchema(this.getSchema(declaration.init, scope), declaration);
				}
			}
		} else if (statement.type == 'ExpressionStatement') {
			this.walkExpression(statement.expression, scope);
		} else {
			throw new Error("Unknown type: " + arguments[0].type);
		}
	},
	walkExpression: function (expression, scope) {
		if (expression.type == 'Literal') {
			// Nothing to do
		} else if (expression.type == 'AssignmentExpression') {
			if (expression.operator != '=') {
				throw new Error("Not implemented: " + expression.operator);
			}
			var variable = this.getVariable(expression.left, scope);
			variable.setSchema(this.getSchema(expression.right, scope), expression);
			variable.setRequired();
		} else {
			throw new Error("Unknown type: " + arguments[0].type);
		}
	},
	getSchema: function (expr, scope) {
		if (expr.type === 'Literal') {
			// Create a new schema for the appropriate literal value
			if (typeof expr.value === 'undefined') {
				return new jsSchema.Schema({type: 'undefined'});
			} else if (expr.value === null) {
				return new jsSchema.Schema({type: 'null'});
			} else if (typeof expr.value === 'boolean') {
				return new jsSchema.Schema({type: 'boolean', 'enum': [expr.value]});
			} else if (typeof expr.value === 'number') {
				var basic = {
					type: (expr.value%1 === 0) ? 'integer' : 'number',
					'enum': [expr.value],
					minimum: expr.value,
					maximum: expr.value
				};
				return new jsSchema.Schema(basic);
			} else if (typeof expr.value === 'string') {
				return new jsSchema.Schema({type: 'string', 'enum': [expr.value]});
			} else {
				throw new Error("Unsupported literal value: " + expr.value);
			}
			return replacement;
		} else if (expr.type === 'ObjectExpression') {
			var schema = new jsSchema.Schema({type: 'object'});
			for (var i = 0; i < expr.properties.length; i++) {
				var keyExpr = expr.properties[i].key;
				var keyValue = (keyExpr.type === 'Literal') ? keyExpr.value : keyExpr.name;
				var valueExpr = expr.properties[i].value;
				schema.properties = schema.properties || {};
				schema.properties[keyValue] = this.getSchema(valueExpr, scope);
				schema.required = schema.required || [];
				schema.required.push(keyValue);
			}
			// TODO: transfer comments to the entries
			return schema;
		} else if (expr.type === 'ArrayExpression') {
			var schema = new jsSchema.Schema({type: 'array'});
			var valueSchemas = [];
			for (var i = 0; i < expr.elements.length; i++) {
				var valueExpr = expr.elements[i];
				valueSchemas.push(this.getSchema(valueExpr, scope));
			}
			if (valueSchemas.length > 0) {
				schema.items = jsSchema.Schema.merge(valueSchemas);
			}
			// TODO: transfer comments to the entries
			return schema;
		} else {
			var variable = this.getVariable(expr, scope);
			return variable.schema;
		}
	},
	getVariable: function (expr, scope) {
		if (expr.type == 'Literal') {
			var schema = this.getSchema(expr, scope);
			return new jsSchema.Variable(schema);
		} else if (expr.type === 'Identifier') {
			var variableName = expr.name;
			if (!scope[variableName]) {
				this.undeclaredGlobals[variableName] = expr.loc.start;
				this.globalScope[variableName] = new jsSchema.Variable();
			}
			return scope[variableName];
		} else if (expr.type === 'MemberExpression') {
			var objectVariable = this.getVariable(expr.object, scope);
			var exactProperty = null;
			if (expr.computed) {
				var propSchema = this.getSchema(expr.property, scope);
				if (propSchema['enum'] && propSchema['enum'].length === 1) {
					exactProperty = "" + propSchema['enum'][0];
				}
			} else {
				exactProperty = expr.property.name;
			}
			if (objectVariable.couldBeType('array') && exactProperty !== null) {
				if (typeof exactProperty === 'number' || /^(0|[1-9][0-9]*)$/.test(exactProperty)) {
					var arrayIndex = parseInt("" + exactProperty, 10);
					// TODO: something with min/max lengths
					return objectVariable.anyItem(expr);
				}
			}
			if (objectVariable.couldBeType('object') || objectVariable.couldBeType('array')) {
				if (exactProperty !== null) {
					return objectVariable.property(exactProperty, expr);
				} else {
					return objectVariable.anyProperty(expr);
				}
			}
			throw new Error('Only objects should be used with MemberExpressions');
		} else {
			console.log(arguments);
			throw new Error("Unknown type: " + arguments[0].type);
		}
	}
};

module.exports = ClassSet;