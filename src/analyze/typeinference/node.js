(function(ns){

    Shade = require("../../interfaces.js").Shade;
    var TYPES = Shade.TYPES;



    var Node = function (node) {
        this.node = node;
    }

    Node.prototype = {
        checkExtra: function () {
            if (this.node.result == undefined)
                throw new Error("No annotation for node: " + this.node);
        },

        getType: function () {
            this.checkExtra();
            return this.node.result.type || TYPES.ANY;
        },

        setType: function (type) {
            this.node.result = this.node.result || {};
            this.node.result.type = type;
        },

        isOfType: function (type) {
            return this.getType() == type;
        },

        isInt: function () {
            return this.isOfType(TYPES.INT);
        },
        isNumber: function () {
            return this.isOfType(TYPES.NUMBER);
        },
        isNullOrUndefined: function () {
            return this.isNull() || this.isUndefined();
        },
        isNull: function () {
            return this.isOfType(TYPES.NULL);
        },
        isUndefined: function () {
            return this.isOfType(TYPES.UNDEFINED);
        },
        isBool: function () {
            return this.isOfType(TYPES.BOOLEAN);
        },
        isString: function () {
            return this.isOfType(TYPES.STRING);
        },
        isObject: function () {
            return this.isOfType(TYPES.OBJECT) || this.isOfType(TYPES.COLOR) || this.isOfType(TYPES.NORMAL);
        },
        canNumber: function () {
            return this.isNumber() || this.isInt() || this.isBool();
        },
        hasStaticValue : function() {
            this.node.result = this.node.result || {};
            return this.node.result.dynamic !== true;
        },
        setStaticValue : function(v) {
            this.node.result = this.node.result || {};
            this.node.result.staticValue = v;
            this.node.result.dynamic = false;
        },
        getStaticValue : function() {
            if (!this.hasStaticValue()) {
                throw new Error("Node has no static value: " + this.node);
            }
            return this.node.result.staticValue;
        },
        setDynamicValue : function() {
            this.node.result = this.node.result || {};
            delete this.node.result.staticValue;
            this.node.result.dynamic = true;
        }
    }

    ns.Node = Node;

}(exports));
