// External dependencies
var util = require("util");
var extend = require("lodash.assign");
var Syntax = require('estraverse').Syntax;

// Internal dependencies
var Shade = require("../interfaces.js"); // TODO(ksons): Eliminate this dependency
var ErrorHandler = require("./errors.js");
var Annotation = require("./annotation.js").Annotation;
var TypeInfo = require("./typeinfo.js").TypeInfo;
var TYPES = require("./constants.js").TYPES;

/**
 * TODO(ksons): Eliminate this class
 * @param binding
 * @param registry
 * @extends TypeInfo
 * @constructor
 */
var Binding = function (binding, registry) {
    TypeInfo.call(this, binding);
    if (this.node.ref) {
        if (!registry[this.node.ref])
            throw Error("No object has been registered for: " + this.node.ref);
        this.globalObject = registry[this.node.ref].object;
        if (this.globalObject) {
            this.setType(TYPES.OBJECT);
        }
    }
};

util.inherits(Binding, TypeInfo);

extend(Binding.prototype, {
    hasConstructor: function () {
        return !!this.getConstructor();
    },
    getConstructor: function () {
        return this.globalObject && this.globalObject.constructor;
    },
    isInitialized: function () {
        return this.node.initialized;
    },
    setInitialized: function (v) {
        this.node.initialized = v;
    },
    hasStaticValue: function () {
        return this.globalObject ? true : TypeInfo.prototype.hasStaticValue.call(this);
    },
    getStaticValue: function () {
        if (!this.hasStaticValue()) {
            throw new Error("Node has no static value: " + this.node);
        }
        return this.globalObject ? this.globalObject.staticValue : TypeInfo.prototype.getStaticValue.call(this);
    },
    isGlobal: function () {
        return this.node.info && this.node.info._global || TypeInfo.prototype.isGlobal.call(this);
    },
    getType: function () {
        return this.globalObject ? TYPES.OBJECT : TypeInfo.prototype.getType.call(this);
    },
    getStaticProperties: function () {
        if (this.globalObject)
            return this.globalObject.static;
        return null;
    },
    getInfoForSignature: function (signature) {
        var extra = this.getExtra();
        if (!extra.signatures)
            return null;
        return extra.signatures[signature];
    },
    setInfoForSignature: function (signature, info) {
        var extra = this.getExtra();
        if (!extra.signatures)
            extra.signatures = {};
        return extra.signatures[signature] = info;
    }


});


/**
 * @param {Object} node AST node that defines the scope
 * @param {Scope|null} parent
 * @param opt
 * @constructor
 */
var Scope = function (node, parent, opt) {
    opt = opt || {};

    /** @type (Scope|null) */
    this.parent = parent || opt.parent || null;
    this.registry = opt.registry || (parent ? parent.registry : {});

    this.scope = node.scope = node.scope || {};

    /** @type {Object.<string, {initialized: boolean, annotation: Annotation}>} */
    this.scope.bindings = this.scope.bindings || {};
    if (opt.bindings) {
        extend(this.scope.bindings, opt.bindings);
    }

    this.scope.name = opt.name || node.name || "|anonymous|";

};

extend(Scope.prototype, {
    setRegistry: function (registry) {
        this.registry = registry;
    },
    getName: function () {
        return this.scope.name;
    },
    getRootContext: function () {
        if (this.parent)
            return this.parent.getRootContext();
        return this;
    },

    getBindings: function () {
        return this.scope.bindings;
    },

    updateReturnInfo: function (annotation) {
        this.scope.returnInfo = annotation.getExtra();
    },
    getReturnInfo: function () {
        return this.scope.returnInfo || {type: TYPES.UNDEFINED};
    },

    /**
     * @param {string} name
     * @returns {*}
     */
    getBindingByName: function (name) {
        var bindings = this.getBindings();
        var binding = bindings[name];
        if (binding !== undefined)
            return new Binding(binding, this.registry);
        if (this.parent)
            return this.parent.getBindingByName(name);
        return undefined;
    },

    /**
     * @param {string} name
     * @returns {Scope|null}
     */
    getContextForName: function (name) {
        var bindings = this.getBindings();
        if (bindings[name] !== undefined)
            return this;
        if (this.parent)
            return this.parent.getContextForName(name);
        return null;
    },

    getVariableIdentifier: function (name) {
        var scope = this.getContextForName(name);
        if (!scope)
            return null;
        return scope.str() + "." + name;
    },

    declareVariable: function (name, fail, position) {
        var bindings = this.getBindings();
        fail = (fail == undefined) ? true : fail;
        if (bindings[name]) {
            if (fail) {
                throw new Error(name + " was already declared in this scope.")
            } else {
                return false;
            }
        }

        bindings[name] = {
            initialized: false,
            initPosition: position,
            extra: {
                type: TYPES.UNDEFINED
            }
        };
        return true;
    },

    /**
     *
     * @param {string} name
     * @param {TypeInfo} typeInfo
     * @param {Object} node AST node the new type info originates from
     */
    updateTypeInfo: function (name, typeInfo, node) {
        var v = this.getBindingByName(name);
        if (!v) {
            if (node) {
                typeInfo.setInvalid(ErrorHandler.generateErrorInformation(node, ErrorHandler.ERROR_TYPES.REFERENCE_ERROR, name, "is not defined"));
                return;
            }
            throw new Error("Reference error: " + name + " is not defined.")
        }
        if (v.isInitialized() && v.getType() !== typeInfo.getType()) {
            if (node) {
                typeInfo.setInvalid(ErrorHandler.generateErrorInformation(node, ErrorHandler.ERROR_TYPES.SHADEJS_ERROR, name, "may not change it's type"));
                return;
            }
            throw new Error("Variable may not change it's type: " + name);
        }
        if (!v.isInitialized()) {
            // Annotate the declaration, if one is given
            if (v.node.initPosition)
                v.node.initPosition.copy(typeInfo);
        }

        v.copy(typeInfo);
        v.setDynamicValue();
        v.setInitialized(!typeInfo.isUndefined());
    },

    registerObject: function (name, obj) {
        this.registry[obj.id] = obj;
        var bindings = this.getBindings();
        bindings[name] = {
            extra: {
                type: TYPES.OBJECT
            },
            ref: obj.id
        };
    },

    declareParameters: function (params) {
        var bindings = this.getBindings();
        for (var i = 0; i < params.length; i++) {
            var parameter = params[i];
            var annotation = new Annotation(parameter);

            var node = {extra: {type: TYPES.UNDEFINED}};
            var binding = new TypeInfo(node);
            binding.copy(annotation);
            bindings[parameter.name] = node;
        }
    },

    str: function () {
        var ctx = this;
        var names = [];
        while (ctx) {
            names.unshift(ctx.getName());
            ctx = ctx.parent;
        }
        return names.join(".");
    },

    getAllBindings: function () {
        var result = Object.keys(this.getBindings());
        if (this.parent) {
            var parentBindings = this.parent.getAllBindings();
            for (var i = 0; i < parentBindings.length; i++) {
                if (result.indexOf(parentBindings[i]) !== -1) {
                    result.push(parentBindings[i]);
                }
            }
        }
        return result;
    },

    /**
     *
     * @param node
     * @returns {TypeInfo}
     */
    createTypeInfo: function (node) {
        var result = new Annotation(node);
        if (node.type == Syntax.Identifier) {
            var name = node.name;
            var binding = this.getBindingByName(name);
            if (binding) {
                result.copy(binding);
                return binding;
            }
        }
        return result;
    },

    getObjectInfoFor: function (obj) {
        if (!obj.isObject())
            return null;

        // There are three ways to get the properties of an object

        // 1. Object is static and has registered it's properties via reference
        var staticProperties = obj.getStaticProperties();
        if (staticProperties)
            return staticProperties;

        // 1: Object is generic (any), then it carries it's information itself
        if (obj.isOfKind(Shade.OBJECT_KINDS.ANY)) {
            return obj.getNodeInfo();
        }


        // 3. Last chance: The object is an instance of a registered type,
        // then we get the information from it's kind
        return this.registry && this.registry.getInstanceForKind(obj.getKind()) || null;
    }

});


module.exports = Scope;




