var obj = {
	initialProp: "foo"
};
obj.prop1 = 5;
obj['prop2'] = false;
obj[obj.prop1] = "test";

var obj2 = obj;