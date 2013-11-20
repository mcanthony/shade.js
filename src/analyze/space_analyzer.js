(function (module) {

    // dependencies
    var walker = require('walkes');
    var worklist = require('analyses');
    var common = require("../base/common.js");
    var esgraph = require('esgraph');
    var codegen = require('escodegen');
    var Tools = require("./settools.js");
    var Shade = require("./../interfaces.js");

    // shortcuts
    var Syntax = common.Syntax;
    var Set = worklist.Set,
        Types = Shade.TYPES,
        Kinds = Shade.OBJECT_KINDS;

    // defines

    /**
     * Possible Spaces
     * @enum
     */
    var SpaceType = {
        OBJECT: 0,
        VIEW: 1,
        WORLD: 2
    };
    var VectorType = {
        NONE: 0,
        POINT: 1,
        NORMAL: 2
    };
    var SpaceVectorType = {
        OBJECT: SpaceType.OBJECT,
        VIEW_POINT : SpaceType.VIEW + (VectorType.POINT << 3),
        WORLD_POINT : SpaceType.WORLD + (VectorType.POINT << 3),
        VIEW_NORMAL : SpaceType.VIEW + (VectorType.NORMAL << 3),
        WORLD_NORMAL : SpaceType.WORLD + (VectorType.NORMAL << 3)
    };
    function getVectorFromSpaceVector(spaceType){
        return spaceType >> 3;
    }
    function getSpaceFromSpaceVector(spaceType){
        return spaceType % 8;
    }

    /**
     * @param cfg
     * @param {FlowNode} start
     * @returns {Map}
     */
    function analyze(aast) {
        var cfg = esgraph(aast, { omitExceptions: true });

        var output = worklist(cfg, transferSpaceInfo, {
            direction: 'backward',
            start: null,
            merge: worklist.merge(mergeSpaceInfo)
        });
        var startNodeResult = output.get(cfg[0]);
        var result = {};
        startNodeResult.forEach(function(elem) {
            if(!result[elem.name]) result[elem.name] = [];
            result[elem.name].push(elem.space);
        });
        return result;
    }

    function setSpaceInfo(ast, key, value){
        if(!ast.spaceInfo)
            ast.spaceInfo = {};
        ast.spaceInfo[key] = value;
    }

    /**
     * @param {Set} input
     * @this {FlowNode}
     * @returns {Set} output with respect to input
     */
    function transferSpaceInfo(input) {
        if (this.type || !this.astNode) // Start and end node do not influence the result
            return input;

        // Local
        var kill = this.kill = this.kill || Tools.findVariableDefinitions(this.astNode);
        var generatedDependencies = this.generate = this.generate || generateSpaceDependencies(this.astNode, kill);
        //generate && console.log(this.label, generate);

        // Depends on input
        var depSpaceInfo = new Set(), finalSpaces = null;
        setSpaceInfo(this.astNode, "transferSpaces", null);
        setSpaceInfo(this.astNode, "hasSpaceOverrides", generatedDependencies.dependencies.spaceOverrides.length > 0);
        if(generatedDependencies.def){
            var def = generatedDependencies.def;
            setSpaceInfo(this.astNode, "def", def);
            var spaceTypes = getSpaceVectorTypesFromInfo(input, def);
            if(spaceTypes.size >= 1){
                setSpaceInfo(this.astNode, "transferSpaces", spaceTypes);
                finalSpaces = createSpaceInfoFromDependencies(depSpaceInfo, generatedDependencies.dependencies, spaceTypes);
            }
        }
        else{
            finalSpaces = createSpaceInfoFromDependencies(depSpaceInfo, generatedDependencies.dependencies, new Set([SpaceVectorType.OBJECT]));
        }
        setSpaceInfo(this.astNode, "finalSpaces", (finalSpaces && finalSpaces.size > 0) ? finalSpaces : null);

        input = new Set(input.filter(function (elem) {
            return !kill.has(elem.name);
        }));
        return mergeSpaceInfo(input, depSpaceInfo);
    }

    function getSpaceVectorTypesFromInfo(spaceInfo, identifier){
        return new Set(spaceInfo.filter(function(elem){return elem.name == identifier}).map(function(elem){ return elem.space}));
    }
    function isSpaceTypeValid(spaceType, dependencies){
        var type = getVectorFromSpaceVector(spaceType);
        return type == VectorType.NONE || (type == VectorType.NORMAL && !dependencies.normalSpaceViolation)
           || (type == VectorType.POINT && !dependencies.pointSpaceViolation);
    }

    function createSpaceInfoFromDependencies(depSpaceInfo, dependencies, spaces){
        var finalSpaces = new Set();
        dependencies.toObjectSet.forEach(function(name){
            depSpaceInfo.add({name: name, space: SpaceVectorType.OBJECT});
        })
        spaces.forEach(function(spaceType){
            if(getSpaceFromSpaceVector(spaceType) != SpaceType.OBJECT && dependencies.hasDirectVec3SpaceOverride())
                throw new Error("Detection of repeated space conversion. Not supported!");
            if(isSpaceTypeValid(spaceType, dependencies)){
                finalSpaces.add(spaceType);
            }
            spaceType = isSpaceTypeValid(spaceType, dependencies) ?  spaceType : SpaceVectorType.OBJECT;

            dependencies.propagateSet.forEach(function(name){
                depSpaceInfo.add({name: name, space: spaceType});
            });
        });
        var overrides = dependencies.spaceOverrides;
        for(var i = 0; i < overrides.length; ++i){
            createSpaceInfoFromDependencies(depSpaceInfo, overrides[i].dependencies, new Set( [overrides[i].space] ));
        }
        return finalSpaces;
    }


    /**
     * Special merge function that merges entries with same names
     * to a new entry with top element Semantic.UNKNOWN
     * @param {Set} a
     * @param {Set} b
     * @returns {Set}
     */
    function mergeSpaceInfo(a, b) {
        if (!a && b)
            return new Set(b);
        var s = new Set(a);
        if (b)
            b.forEach(
                function (elem) {
                    var name = elem.name, space = elem.space;
                    var resultA = a.filter(function (other) {
                        return other.name == name && other.space == space;
                    });
                    if (!resultA.length) {
                        s.add(elem);
                    }
                }
            );
        return s;
    }

    function SpaceDependencies(){
        this.normalSpaceViolation = null;
        this.pointSpaceViolation = null;
        this.propagateSet = new Set();
        this.toObjectSet = new Set();
        this.spaceOverrides = [];
    }

    SpaceDependencies.prototype.addSpaceOverride = function(space, fromObjectSpace, dependencies){
        this.spaceOverrides.push({ space: space, fromObjectSpace: fromObjectSpace, dependencies: dependencies})
    }
    SpaceDependencies.prototype.hasDirectVec3SpaceOverride = function(){
        var i = this.spaceOverrides.length;
        while(i--){
            if(!this.spaceOverrides[i].fromObjectSpace)
                return true;
        }
        return false;
    }


    function generateSpaceDependencies(ast, defs) {
        var result = {def: null, dependencies: new SpaceDependencies()};
        if (!ast && !ast.type)
            return result;
        var defCount = defs.size;
        if (defCount > 1)
            throw new Error("Code not sanitized, found multiple definitions in one statement");
        if(defCount == 1)
            result.def = defs.values()[0];
        // TODO: Properly determine FLOAT3 statements
        var isFloat3Statement = (ast.extra && ast.extra.kind == Kinds.FLOAT3);

        if(isFloat3Statement){
            gatherSpaceDependencies(ast, result.dependencies);
            setSpaceInfo(ast, "propagateSet", result.dependencies.propagateSet);
        }
        else
            gatherObjectDependencies(ast, result.dependencies);

        return result;
    }

    function getSpaceConversion(callAst){
        var callee = callAst.callee;
        if(callee.type == Syntax.MemberExpression && callee.object.type == Syntax.ThisExpression){
            var spaceType = 0;
            switch(callee.property.name){
                case "transformPoint": spaceType = VectorType.POINT; break;
                case "transformNormal": spaceType = VectorType.NORMAL; break;
            }
            spaceType = spaceType << 3;
            if(spaceType){
                var firstArg = callAst.arguments[0];

                if(firstArg.type != Syntax.MemberExpression || firstArg.object.type != Syntax.Identifier
                    || firstArg.object.name != "Space" || firstArg.property.type != Syntax.Identifier)
                    throw new Error("The first argument of '" + callee.property + "' must be a Space enum value.");
                switch(firstArg.property.name){
                    case "VIEW" : spaceType += SpaceType.VIEW; break;
                    case "WORLD": spaceType += SpaceType.WORLD; break;
                }
                return spaceType;
            }
        }
        return null;
    }

    function handleSpaceOverride(callAst, result, fromObjectSpace){
        var space = getSpaceConversion(callAst);
        if(space){
            var subResult = new SpaceDependencies();
            gatherSpaceDependencies(callAst.arguments[1], subResult);
            result.addSpaceOverride(space, fromObjectSpace, subResult, callAst);
            setSpaceInfo(callAst, "spaceOverride", space);
            setSpaceInfo(callAst, "propagateSet", subResult.propagateSet);
            return true;
        }
        return false;
    }

    function gatherObjectDependencies(ast, result){
        walker(ast, {
            VariableDeclaration: function(){},
            Identifier: function(){
                if(this.extra.kind == Kinds.FLOAT3){
                    result.toObjectSet.add(this.name);
                }

            },
            MemberExpression: function (recurse) {
                if(this.extra.kind == Kinds.FLOAT3){
                    if (this.object.type == Syntax.Identifier && this.property.type == Syntax.Identifier) {
                        if(this.object.extra.global)
                            result.propagateSet.add("env." + this.property.name);
                        else{
                            throw new Error("Member Access of non 'env' object in space equation - not supported.");
                        }
                    }
                }
                else{
                    recurse(this.object);
                    recurse(this.property);
                }
            },
            CallExpression: function (recurse) {
                if(handleSpaceOverride(this, result, true))
                    return;
                recurse(this.callee);
                recurse(this.arguments);
            }
        });
    }

    function gatherSpaceDependencies(ast, result) {
        walker(ast, {
            VariableDeclaration: function(){},
            AssignmentExpression: function (recurse) {
                recurse(this.right);
            },
            Identifier: function () {
                if(this.extra.kind == Kinds.FLOAT3){
                    result.propagateSet.add(this.name);
                    setSpaceInfo(this, "propagate", true);
                }
             },
            NewExpression: function (recurse) {
                if(this.callee == "Vec3"){
                    handleVec3Args(this.arguments, recurse, result, false);
                }
            },
            MemberExpression: function (recurse) {
                if(this.extra.kind == Kinds.FLOAT3){
                    if (this.object.type == Syntax.Identifier && this.property.type == Syntax.Identifier) {
                        if(this.object.extra.global)
                            result.propagateSet.add("env." + this.property.name);
                        else{
                            throw new Error("Member Access of non 'env' object in space equation - not supported.")
                        }
                        setSpaceInfo(this, "propagate", true);
                    }
                }
                else{
                    recurse(this.object);
                    recurse(this.property);
                }
            },
            CallExpression: function (recurse) {
                if(handleSpaceOverride(this, result, false))
                    return;
                result.pointSpaceViolation = true;
                if (this.callee.type == Syntax.MemberExpression) {
                    var callObject = this.callee.object;
                    var objectKind = callObject.extra.kind,
                        method = this.callee.property.name,
                        args = this.arguments;
                    if(PropagationRules[objectKind] && PropagationRules[objectKind][method]){
                        PropagationRules[objectKind][method](callObject, args, recurse, result);
                        return;
                    }
                    console.log("Unhandled: ", codegen.generate(this))
                }
                else{
                    gatherObjectDependencies(this.arguments, result);
                }
            }
        });
    }

    function handleScaleOperator(callObject, args, recurse, result){
        handleVec3Args(args, recurse, result, true);
        recurse(callObject);
    }
    function handleAddSubOperation(callObject, args, recurse, result){
        handleVec3Args(args, recurse, result, false);
        recurse(callObject);
    }

    function handleVec3Args(args, recurse, result, scaling){
        if(!scaling && args.length == 0){
            result.normalSpaceViolation = true;
            return;
        }
        if(args.length > 1){
            result.normalSpaceViolation = true;
            return;
        }
        if(args.length == 1){
            if(args[0].extra.kind == Kinds.FLOAT3){
                recurse(args[0]);
            }
            else if(scaling && args[0].extra.type == Types.NUMBER){
                gatherObjectDependencies(args[0], result);
            }
            else{
                result.normalSpaceViolation = true;
            }
        }
    }


    var PropagationRules = {
        "float3" : {
            "add" : handleAddSubOperation,
            "sub" : handleAddSubOperation,
            "mul" : handleScaleOperator,
            "div" : handleScaleOperator,
            "normalize" : handleScaleOperator
        }
    }
    module.exports = {
        SpaceVectorType: SpaceVectorType,
        SpaceType: SpaceType,
        VectorType: VectorType,
        getVectorFromSpaceVector: getVectorFromSpaceVector,
        getSpaceFromSpaceVector: getSpaceFromSpaceVector,
        analyze: analyze
    };

}(module));
