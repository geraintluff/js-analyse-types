function JsSchema(initial) {
	if (initial) {
		for (var key in initial) {
			if (typeof initial[key] !== 'undefined') {
				this[key] = initial[key];
			}
		}
	}
};
JsSchema.prototype = {
	shallowCopy: function () {
		return new JsSchema(this);
	},
	couldBeType: function (type) {
		if (!this.type || this.type === type) {
			return true;
		} else if (Array.isArray(this.type) && this.type.indexOf(type) !== -1) {
			return true;
		}
		return false;
	}
};
// Merge schemas (without using oneOf/anyOf)
JsSchema.merge = function (sequence) {
	// TODO: concatenate titles/descriptions

	var newSequence = [];
	for (var i = 0; i < sequence.length; i++) {
		if (sequence[i].ignoreWhenMerging) {
			continue;
		}
		newSequence.push(sequence[i]);
	}
	sequence = newSequence;
	if (sequence.length == 0) {
		return new JsSchema({ignoreWhenMerging: true});
	} else if (sequence.length == 1) {
		return sequence[0].shallowCopy();
	}
	
	var result = new JsSchema();
	var types = null;
	for (var i = 0; i < sequence.length; i++) {
		var entryTypes = sequence[i].type;
		if (entryTypes) {
			types = types || {};
			if (!Array.isArray(entryTypes)) {
				entryTypes = [entryTypes];
			}
			for (var j = 0; j < entryTypes.length; j++) {
				types[entryTypes[j]] = true;
				if (entryTypes[j] === 'number') {
					types['integer'] = true;
				}
			}
		} else {
			types = null;
			break;
		}
	}
	if (types) {
		if (types['number'] && types['integer']) {
			delete types['integer'];
		}
		result.type = Object.keys(types);
	}
	if (result.couldBeType('object')) {
		for (var i = 0; i < sequence.length; i++) {
			if (sequence[i].properties) {
				for (var key in sequence[i].properties) {
					result.properties = result.properties || {};
					if (result.properties[key]) {
						result.properties[key] = JsSchema.merge([result.properties[key], sequence[i].properties[key]]);
					} else if (result.additionalProperties) {
						result.properties[key] = JsSchema.merge([result.additionalProperties, sequence[i].properties[key]]);
					} else {
						result.properties[key] = sequence[i].properties[key].copy();
					}
				}
			}
			if (sequence[i].additionalProperties) {
				if (result.additionalProperties) {
					result.additionalProperties = JsSchema.merge([result.additionalProperties, sequence[i].additionalProperties]);
				} else {
					result.additionalProperties = sequence[i].additionalProperties.copy();
				}
				if (result.properties) {
					for (var key in result.properties) {
						if (!sequence[i].properties || !sequence[i].properties[key]) {
							result.properties[key] = JsSchema.merge([result.properties[key], sequence[i].additionalProperties]);
						}
					}
				}
			}
		}
	}
	if (result.couldBeType('number') || result.couldBeType('integer')) {
		var minimum = null;
		var exclusiveMinimum = false;
		var maximum = null;
		var exclusiveMaximum = false;
		for (var i = 0; i < sequence.length; i++) {
			if (minimum === false || typeof sequence[i].minimum !== 'number') {
				minimum = false;
			} else if (minimum === null || sequence[i].minimum > minimum) {
				minimum = sequence[i].minimum;
				exclusiveMinimum = !!sequence[i].exclusiveMinimum;
			}
			if (maximum === false || typeof sequence[i].maximum !== 'number') {
				maximum = false;
				break;
			} else if (maximum === null || sequence[i].maximum < maximum) {
				maximum = sequence[i].maximum;
				exclusiveMaximum = !!sequence[i].exclusiveMaximum;
			}
		}
		if (typeof minimum === 'number') {
			result.minimum = minimum;
			if (exclusiveMinimum) {
				result.exclusiveMinimum = true;
			}
		}
		if (typeof maximum === 'number') {
			result.maximum = maximum;
			if (exclusiveMaximum) {
				result.exclusiveMaximum = true;
			}
		}
	}
	return result;
};

var anonymousCounter = 0;
var KEEP_HISTORY = false;
function JsVariable(initial, declaration) {
	var thisVariable = this;
	if (typeof declaration === 'object' && declaration.id) {
		// TODO: check comments for nicer name/id/description/etc
		this.id = (declaration.id.name || '$var$') + ":" + declaration.loc.start.line + ":" + declaration.loc.start.column;
	} else {
		this.id = "$anon" + (anonymousCounter++) + "$";
	}
	if (KEEP_HISTORY) this.history = {};
	
	var propertyVariables = null;
	var anyPropertyVariable = null;
	this.property = function (key, expr) {
		if (anyPropertyVariable) {
			return anyPropertyVariable;
		}
		propertyVariables = propertyVariables || {};
		this.propertyVariables = propertyVariables;
		if (!propertyVariables[key]) {
			this.schema.properties = this.schema.properties || {};
			this.schema.properties[key] = this.schema.properties[key] || new JsSchema({ignoreWhenMerging: true});
			propertyVariables[key] = new JsVariable(this.schema.properties[key], expr);
			propertyVariables[key].setSchema = function (schema, tag) {
				schema = JsSchema.merge([thisVariable.schema.properties[key], schema]);
				propertyVariables[key] = new JsVariable(schema, tag);
				propertyVariables[key].setSchema = this.setSchema;
				thisVariable.schema.properties[key] = schema;
			};
			propertyVariables[key].setRequired = function () {
				thisVariable.schema.required = thisVariable.schema.required || [];
				if (thisVariable.schema.required.indexOf(key) === -1) {
					thisVariable.schema.required.push(key);
				}
			};
		}
		return propertyVariables[key];
	};
	this.anyProperty = function (expr) {
		var setSchema = anyPropertyVariable ? null : new JsSchema({ignoreWhenMerging: true});
		if (propertyVariables) {
			var propertySchemas = [];
			for (var key in propertyVariables) {
				propertySchemas.push(propertyVariables[key].schema);
			}
			propertyVariables = null;
			setSchema = JsSchema.merge(propertySchemas);
		}
		if (setSchema) {
			delete this.schema.properties;
			this.schema.additionalProperties = this.schema.additionalProperties || setSchema;
			anyPropertyVariable = new JsVariable(this.schema.additionalProperties, expr);
			anyPropertyVariable.setSchema = function (schema, tag) {
				schema = JsSchema.merge([thisVariable.schema.additionalProperties, schema]);
				anyPropertyVariable = new JsVariable(schema, tag);
				anyPropertyVariable.setSchema = this.setSchema;
				thisVariable.schema.additionalProperties = schema;
			};
		}
		return anyPropertyVariable;
	};
	
	var anyItemVariable = null;
	this.anyItem = function (expr) {
		if (!anyItemVariable) {
			this.schema.items = this.schema.items || new JsSchema({ignoreWhenMerging: true});
			anyItemVariable = new JsVariable(this.schema.items, expr);
			anyItemVariable.setSchema = function (schema, tag) {
				schema = JsSchema.merge([thisVariable.schema.items, schema]);
				anyItemVariable = new JsVariable(schema, tag);
				anyItemVariable.setSchema = this.setSchema;
				thisVariable.schema.items = schema;
			};
		}
		return anyItemVariable;
	};
	
	this.setSchema = function (schema, tag) {
		if (schema.anyProperty) throw new Error("wtf");
		if (typeof tag === 'object') {
			tag = JsVariable.tagForExpression(tag);
		}
		this.tag = tag;
		this.schema = schema;
		this.schema.id = this.id + " at " + tag;
		if (KEEP_HISTORY) this.history[tag] = schema;

		if (schema.properties) {
			for (var key in schema.properties) {
				this.property(key).setSchema(schema.properties[key]);
			}
		}
		if (schema.additionalProperties) {
			this.anyProperty().setSchema(schema.additionalProperties);
		}
	};

	initial = initial || new JsSchema();
	this.setSchema(initial, (typeof declaration === 'object') ? JsVariable.tagForExpression(declaration) : (declaration || "declaration"));
}
JsVariable.prototype = {
	setRequired: function () {
		// Nothing to do
	},
	couldBeType: function (type) {
		return this.schema.couldBeType(type);
	}
};
JsVariable.tagForExpression = function (expr) {
	return expr.loc.end.line + ":" + expr.loc.end.column;
}

var RegExpSchema = new JsSchema({
	type: 'object',
	properties: {
		global: new JsSchema({type: 'boolean'}),
		ignoreCase: new JsSchema({type: 'boolean'}),
		lastIndex: new JsSchema({type: 'integer', minimum: 0}),
		multiline: new JsSchema({type: 'boolean'}),
		source: new JsSchema({type: 'string'}),
		exec: new JsSchema({type: 'function', 'input': [{type: 'string'}], 'output': {type: ['null', 'array'], 'items': {type: 'string'}}}),
		test: new JsSchema({type: 'function', 'input': [{type: 'string'}], 'output': {type: 'boolean'}})
	}
});

module.exports = {
	Schema: JsSchema,
	Variable: JsVariable
};