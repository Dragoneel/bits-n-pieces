var doView=true;
var generateVirtual=true;
var generateJoin=true;
var debugOn=false;
var replaceDots=true;
var depth=0;
var mongodb_svr="mongo_server";
var databaseOption="db";
var includeFields=[];
var excludeFields=[];
var schemaFilter={};
var sample = 100;
var subsep="__";
var maxdepth=5;
var geo2d=[];
var geo2dsphere=[];


/**
 * calculates schema of a collection by sampling some of the documents
 * and outputs approximately "equivalent" relational schema
 * 
 * @param {Array} documents 
 * @param {Object} options currently supports these options: 
 *                 flat: true/false    flatten the schema to dot-notation top-level names
 *                 data: true/false    run data sampling and return information about data
 *                 filter: {...}       only return fields/subfields that match the filter
 *
 * @returns {Object} the schema document with counts (#count), types (#type),
 *                   an array flag (#array) and probability of occurrence
 *                   given the parent field (#prob).
 */
function schema(documents, options) {
    var SCHEMA_VERSION = "0.6.0";

    /**
     * right-aligned string split
     * 
     * @param {String} str string to split 
     * @param {String} sep character to use for split, or null for any whitespace
     * @param {Number} maxsplit maximum number of splits (from the end of the string)
     *
     * @returns {Array} an array with (if provided, at most maxsplit) elements
     *
     * @example
     * // returns ["foo.bar", "baz"]
     * _rsplit( "foo.bar.baz", ".", 1 )
     */
    function _rsplit(str, sep, maxsplit) {
        var split = str.split(sep || /\s+/);
        return maxsplit ? [ split.slice(0, -maxsplit).join(sep) ].concat(split.slice(-maxsplit)) : split;    
    }

    /**
     * flattens an object and results in an object with only top-level properties with dot-notation
     * 
     * @param {Object} obj object to flatten
     *
     * @return {Number} maxsplit maximum number of splits (from the end of the string)
     *
     * @example
     * // returns {"a.b" 1, "a.c": false}
     * _flatten( {a: {b: 1, c: false}} )
     */
    var _flatten = function(obj) {
        function recursive(obj) {
            var result = {};
            
            for (var o in obj) {
                if (!obj.hasOwnProperty(o)) continue;
                /* do not flatten arrays! */
                if ( (  ((typeof obj[o]) === 'object')
                        && (!obj[o]["#array"])
                        && ([$t, $d].indexOf(o) === -1) )
                        || (o=="coordinates")
                   )  {
                    var flatObject = recursive(obj[o]);
                    for (var x in flatObject) {
                        if (!flatObject.hasOwnProperty(x)) continue;
                        result[o + '.' + x] = flatObject[x];
                    }
                } else {
                    result[o] = obj[o];
                }
            }
            return result;
        }

        // first flatten completely
        var flatobj = recursive(obj);

        // now fold back in $-prefixed leaves
        var finalobj = {};
        
        for (var f in flatobj) {
            // only own properties
            if (!flatobj.hasOwnProperty(f)) continue;

            if (f.indexOf('.') !== -1) {
                var split = _rsplit(f, '.', 1);
                if (!(split[0] in finalobj)) {
                    finalobj[split[0]] = {};
                }
                finalobj[split[0]][split[1]] = flatobj[f];
            } else {
                finalobj[f] = flatobj[f];
            }
        }

        return finalobj;
    };

    
    /**
     * recursively infers a schema of an object, keeping track of counts and types of nested objects
     *
     * @mixin {Object} schema resulting schema, initially {}
     * @param {Object} obj object to infer schema
     * 
     */
    function _infer(schema, obj) {
        schema[$c] = ($c in schema) ? schema[$c] + 1 : 1;
        
        if (!($t in schema)) {
            schema[$t] = {};
        }

        // special case: ObjectId, it's an object but we don't want to reach into it
        if (typeof ObjectId !== 'undefined' && obj instanceof ObjectId) {
            type = 'objectid';
            schema[$t][type] = (type in schema[$t]) ? schema[$t][type] + 1 : 1;
            return schema;        
        }

        if (obj instanceof NumberLong || obj instanceof NumberInt) {
            type = 'number';
            schema[$t][type] = (type in schema[$t]) ? schema[$t][type] + 1 : 1;
            return schema;        
        }

        // special case: Date (ISODate is also a Date)
        if (obj instanceof Date) {
            type = 'date';
            schema[$t][type] = (type in schema[$t]) ? schema[$t][type] + 1 : 1;
            return schema;        
        }

        // special case: nulls get their own type
        if (obj === null) {
            type = 'null';
            schema[$t][type] = (type in schema[$t]) ? schema[$t][type] + 1 : 1;
            return schema;        
        }        

        var type = typeof obj;
        schema[$t][type] = (type in schema[$t]) ? schema[$t][type] + 1 : 1;

        if (obj && typeof obj == 'object') {

            Object.keys(obj).forEach(function(key) {
                var val = obj[key];
                if (val == "") val = null;
                if (!(key in schema)) {
                    schema[key] = {};
                }

                if (val instanceof Array) {
                    // special case: lists collapse here
                    val.forEach(function (el) {
                        // create n fake documents with single value
                        var doc = {};
                        doc[key] = el;
                        _infer(schema, doc);
                    });
                    // subtract n from total count
                    schema[$c] -= val.length;
                    schema[key][$a] = true;
                    // no need to infer data, has happened during collapsing already
                    return;
                } else {
                    // objects need to be handled recursively
                    _infer(schema[key], val)
                }

                // handle data inference
                if (options.data && (Object.keys(schema[key][$t]).length === 1)) {
                    if (!($d in schema[key])) {
                        schema[key][$d] = {};
                    }
                    var d = schema[key][$d];
                    switch (typeof val) {
                        // numbers, calculate min and max
                        case 'number':
                            if (!('min' in d)) d['min'] = Infinity;
                            if (!('max' in d)) d['max'] = -Infinity;
                            d['min'] = (val < d['min']) ? val : d['min']; 
                            d['max'] = (val > d['max']) ? val : d['max']; 
                            break;
                        // strings, collect histogram
                        case 'string':
                            if (val in d) {
                                d[val]++;
                            } else {
                                if (Object.keys(d).length < options.data.maxCardinality) {
                                    d[val] = 1;
                                } else {
                                    d[$o] = $o in d ? d[$o] + 1 : 1;
                                }
                            }
                            break;
                        case 'object':
                            // dates, calculate min and max date
                            if (val instanceof Date) {
                                if (!('min' in d)) d['min'] = new Date(100000000*86400000);
                                if (!('max' in d)) d['max'] = new Date(-100000000*86400000); 
                                d['min'] = (val.getTime() < d['min'].getTime()) ? val : d['min']; 
                                d['max'] = (val.getTime() > d['max'].getTime()) ? val : d['max']; 
                            }
                            break;
                    }
                }
            });

        }
        return schema;
    }

    /**
     * clean up the output of _infer, collapsing single types and calculating 
     * probabilities (stored in "$p" field)
     *
     * @param {Object} schema 
     * @param {Number} count keep track of count in recursive calls
     * 
     * @returns {Object} cleaned up schema
     */
    function _cleanup(schema, count) {
        if (typeof schema !== 'object') {
            return schema;
        }

        if (schema[$t] !== undefined) {
            var type_keys = Object.keys(schema[$t]);
            if (type_keys.length === 1) {
                schema[$t] = type_keys[0];
            }
        }

        if (schema[$c] !== undefined) {
            if (count) {
                schema[$p] = schema[$c] / count;
            }
            count = schema[$c];
        }

        if (schema[$d] !== undefined) {
            // remove data for inner nodes
            if (!($t in schema)) {
                delete schema[$d];
            }
            // remove mixed data
            if (typeof schema[$t] === 'object') {
                delete schema[$d];
            }

            // remove boolean data
            if (schema[$t] === 'boolean') {
                delete schema[$d];
            }

            // remove null data
            if (schema[$t] === 'null') {
                delete schema[$d];
            }

            // remove unique strings
            if (schema[$t] === 'string') {
                // check for uniqueness
                var values = Object.keys( schema[$d] ).map(function ( key ) { return schema[$d][key]; });
                var maxCount = Math.max.apply( null, values );
                if (maxCount === 1 && values.length > 1) {
                    schema[$t] = 'text';
                    delete schema[$d];
                } else {
                    schema[$t] = 'category';
                }
            }
        }
            
        // recursive call for each property
        Object.keys(schema).forEach(function (key) {
            if (key === '__schema') return;
            _cleanup(schema[key], count);
        });

        return schema;
    }


    function _uncleanup(schema) {
        if (typeof schema !== 'object') {
            return schema;
        }

        // nest single type under {$type: ...}
        if (schema[$t] !== undefined) {
            if (typeof schema[$t] !== 'object') {
                var obj = {};
                obj[schema[$t]] = schema[$c];
                schema[$t] = obj;
            }
        }

        // combine text/category to string
        if (schema[$t] !== undefined) {
            var string_sum = (schema[$t].text || 0) + (schema[$t].category || 0);
            if (string_sum > 0) {
                if ('text' in schema[$t]) delete schema[$t].text;
                if ('category' in schema[$t]) delete schema[$t].category;
                schema[$t].string = string_sum;
            }            
        }

        // remove $prop 
        if (schema[$p] !== undefined) {
            delete schema[$p];
        }

        // recursive call for each property
        Object.keys(schema).forEach(function (key) {
            if (key === '__schema') return;
            _uncleanup(schema[key]);
        });

        return schema;
    }

    function _getObjectValues(obj) {
        var values = Object.keys(obj).map(function (key) {
            return obj[key];
        });
        return values;
    }

    /**
     * merges the attributes and values from obj into the defaults object 
     * and returns the result.
     * 
     * @param {Obeject} defaults
     * @param {Object} obj
     *
     * @returns {Object} merged object
     */
    function _mergeDefaults(defaults, obj) {
        for (var key in obj) {
            if (!obj.hasOwnProperty(key)) {
                continue;
            }
            defaults[key] = obj[key];
        }
        return defaults;
    }

    /**
     * filter leaf nodes of the schema based on a schema filter document, 
     * only return the matching ones.
     *
     * @param {Object} schema 
     * @param {Number} filter_obj 
     * 
     * @returns {Object} filtered schema
     */
    function _filter(schema, filter_obj) {

        if (typeof schema !== 'object') {
            return false;
        }

        // only filter leaves, skip internal nodes
        var isLeaf = Object.keys(schema).every(function (key) {
            // ignore special keys
            if (metavar_names.indexOf(key) !== -1) {
                return true;
            }
            return (typeof schema[key] !== 'object');
        });

        if (isLeaf) {
            for (fk in filter_obj) {
                if (!(fk in schema) || (schema[fk] != filter_obj[fk])) {
                    return false;
                }
            }
            return true;
        }

        // recursive call for each property
        var matchChildren = Object.keys(schema)
            
            .filter(function(key) {
                return (metavar_names.indexOf(key) === -1);
            })

            .map(function (key) {
                var res = _filter(schema[key], filter_obj);
                if (!res) {
                    delete schema[key];
                }
                return res;
            });

        if (!matchChildren.some( function (d) {return d;} )) {
            return false;
        } else {
            return true;
        }
    }

    // define defaults
    var options = options || {};
    options.raw = options.raw || false;
    options.flat = options.flat === false ? false : true;
    options.data = options.data || false;
    options.filter = options.filter || null;
    options.merge = options.merge || false;
    options.metavars = _mergeDefaults({
        prefix: '#',
        count: 'count', 
        type: 'type', 
        data: 'data', 
        array: 'array', 
        prob: 'prob', 
        other: 'other'
    }, options.metavars);

    var metavar_names = _getObjectValues(options.metavars);

    // remap options.metavars
    var $c = options.metavars.prefix + options.metavars.count,
        $t = options.metavars.prefix + options.metavars.type,
        $d = options.metavars.prefix + options.metavars.data,
        $a = options.metavars.prefix + options.metavars.array,
        $p = options.metavars.prefix + options.metavars.prob,
        $o = options.metavars.prefix + options.metavars.other;

    // nested options.data 
    if (options.data) {
        if (typeof options.data !== 'object') {
            options.data = {};
        }
        options.data.maxCardinality = options.data.maxCardinality || 100;
    }
    
    // infer schema of each document
    if (options.raw) {
        var schema = options.merge.raw_schema || {};
    } else {
        var schema = options.merge ? _uncleanup(options.merge) : {};
    }

    // add schema information
    if (schema['__schema'] !== undefined) {
        // stop if incompatible versions
        var sver = schema['__schema'].version.split('.');
        var myver = SCHEMA_VERSION.split('.');
        if ((sver[0] != myver[0]) || (sver[0] === 0 && (sver[1] != myver[1]))) {
            throw Error('cannot merge schema, version incompatible');
        }
    }

    documents.forEach(function (doc) {
        schema = _infer(schema, doc);
    });

    // clean up schema if not in raw mode
    if (!options.raw) {
        schema = _cleanup(schema);
        // always delete outermost #type
        delete schema[$t];
    }

    // return deep or flat version
    if (options.flat) {
        schema = _flatten(schema);
    }

    // filter schema
    if (options.filter !== null) {
        _filter(schema, options.filter);
    }

    // if merge option set, replace with `true` to avoid circular reference
    if (options.merge) {
        options.merge = true;
    }

    // add schema version and options
    schema['__schema'] = {
        version: SCHEMA_VERSION,
        options: options
    }


    if (options.raw) {
        // piggyback cleanup function on raw output
        return {
            raw_schema: schema,
            cleanup: function() {
                 return _cleanup(schema);     
            }
        }
    }

    return schema;
}

function debug(x) {
   if (debugOn) print("DEBUG: " + Array(depth).join('          ') + x);
}

var allTypes = {
    "none"     : -1,
    "geo"     : 0,
    "boolean" : 1,
    "numeric[]"     : 2,
    "numeric" : 3,
    "date"    : 4,
    "timestamp": 5,
    "varchar" : 6,
    "array"   : 7
};

function schema_stringify(s) {
      ss='';
      for (var f in s) {
         if (!s[f].hasOwnProperty("#pgtype")) continue;
         columnname=f;
         options="";
         if (s[f]["#type"]=="objectid" || s[f].hasOwnProperty("#pgname")) {
            options=" OPTIONS (";
            if (s[f]["#type"]=="objectid") options += "type 'ObjectId',";
            if (s[f].hasOwnProperty("#pgname")) { 
               options += "mname '" + f + "',"; 
               columnname=s[f]["#pgname"];
            }
            options=options.slice(0,-1)+")";
         }
         ss = ss + (replaceDots ? columnname : JSON.stringify(columnname) ) + " " + s[f]["#pgtype"] + options + ",";
      }
      return ss.slice(0,-1);
}


function mapType( t ) {
    debug("mapType: in type " + t);
    if (typeof(t) == "object" && t.hasOwnProperty("#type")) {
      ttype = firstKeyName(t);
      t=ttype;
    }
    debug("mapType: really type " + t);
    if ( [ "objectid", "text", "string", "category", "null" ].indexOf(t) >= 0 ) return "varchar";
    if ( [ "2d", "2darray", "2dsphere" ].indexOf(t) >= 0 ) return "numeric[]";
    if ( [ "boolean" ].indexOf(t) >= 0 ) return "boolean";
    if ( [ "number" ].indexOf(t) >= 0 ) return "numeric";
    if ( [ "date" ].indexOf(t) >= 0 ) return "timestamp";
    /* skipping boolean since Multicorn doesn't handle queries on them */
    /* if ( [ "boolean" ].indexOf(t) >= 0 ) return "boolean"; */
}

function firstKeyName (o) {
    for (var propName in o) {
        if (o.hasOwnProperty(propName)) {
            return propName;
        }
    }
}

/* if passed in a list of types, then return dominant simple type out of it */
function reduceType (types) {
     debug("reduceType: " + tojsononeline(types));
     /* if not array or object ready to return */
     if (typeof(types)!="object") return types;
     debug("Types is " + tojsononeline(types));
     if (types.length==1) return types[0];
     if (types.length==0) return "null";
     if ( types.indexOf("null") >= 0 ) {
        return reduceType(types.filter(function(x) { if (x!="null") return x; }));
     }
     /* if multiple non-"null" types, certain ones force rollup to most permissive type */
     if ( types.indexOf("object") >= 0 ) return "string";
     if ( types.indexOf("category") >= 0 ) return "string";
     if ( types.indexOf("string") >= 0 ) return "string";
     if ( types.indexOf("objectid") >= 0 ) return "string";
     if ( types.indexOf("text") >= 0 ) return "text";
     if ( types.indexOf("date") >= 0 ) return "date";
     if ( types.indexOf("number") >= 0 ) return "number";
     return null;
}

function prepSchema (mschema, dbname, coll, tablename, result) {
    if (depth==0) topLevel=true;
    else topLevel=false;
    depth++;
    debug("prepSchema: " + tojsononeline(mschema));

    if (tablename==coll) throw "do not pass tablename that is same as collection name";
    if (tablename==undefined) 
       if ( replaceDots ) tablename=coll.replace(/\./g,'_');
       else tablename=coll;

    if (result==undefined) result={};
    if (!result.hasOwnProperty(tablename)) result[tablename]={};
    if (!result[tablename].hasOwnProperty("dbname")) result[tablename]["dbname"]=dbname;
    if (!result[tablename].hasOwnProperty("coll")) result[tablename]["coll"]=coll;
    if (!result[tablename].hasOwnProperty("schema")) result[tablename]["schema"]={};
    if (!result[tablename].hasOwnProperty("pipe")) result[tablename]["pipe"]=[];
    if (!result[tablename].hasOwnProperty("fieldmap")) result[tablename]["fieldmap"]={};
    if (!result[tablename].hasOwnProperty("viewmap")) result[tablename]["viewmap"]={};

    debug("prepSchema: Depth is " + depth + " " + dbname + " " + tablename + " result is " + tojsononeline(result));

    numRecords=mschema["#count"];

    var fields = Object.keys(mschema);
    /* first pass is to figure out schema details, handle embedded arrays, etc */
    for (var field in mschema) {

        if ( ! mschema.hasOwnProperty(field) ) continue;
        if ( '__schema' == field ) continue;  /* skip metadata */
        if ( field.startsWith("#") ) continue;  /* skip metadata */
        if ( mschema[field].hasOwnProperty("#skip") && mschema[field]["#skip"] ) continue;

        debug("prepSchema: doing field ********************** " + field);

        var currentfield=mschema[field];
        
        if ( geo2d.indexOf(field) >= 0 ) {
           /* need to handle two element array differently from two field subdocument */
           debug(field + " is a 2d index geo field!!!");
           currentfield["#type"]="2d";
           if (currentfield["#array"]) {
              currentfield["#type"]="2darray";
              delete(currentfield["#array"]);
              result[tablename]["schema"][field]=currentfield;
              /* result[tablename]["viewmap"][field+"[1]"]=field+"_lon";
              result[tablename]["viewmap"][field+"[2]"]=field+"_lat";
              result[tablename][field+"[1]"][field+"[2]"]=field+"_lat";
              currentfield["#pgname"]="numeric"; */
           } else {  /* must be object with two fields */
              var coords=fields.filter(function(z) { if (z.startsWith(field+".")) return z; });
              debug("coords: " + tojson(coords));
              if (coords.length!=2) throw "Why would there more more than two coordinates for " + field + "? ";
              for (var c in coords) { 
                  mschema[c]={};
                  mschema[c]["#pgtype"]="numeric";
                  mschema[c]["#type"]="number";
              }
              mschema[field]["#skip"]=true; /* skip top level, just get coords */
           }
           continue;
        }
        /* here we could support separate table or same one for 2dsphere, depending on whether we support non-points */
        if ( geo2dsphere.indexOf(field) >= 0 ) {
           debug(field + " is a 2dsphere index geo field!!!");
           currentfield["#type"]="2dsphere";
           mschema[field+".coordinates"]["#type"]="2dsphere";
           /* debug("Going to delete " + field+".type and " + field+".coordinates fields"); */
           if (mschema.hasOwnProperty(field+".coordinates") && mschema[field+".coordinates"]["#array"]) {
               delete(mschema[field+".coordinates"]["#array"]);
               result[tablename]["schema"][field+".coordinates"]={};
               for (g in mschema[field+".coordinates"])
                     result[tablename]["schema"][field+".coordinates"][g]=mschema[field+".coordinates"][g];
               result[tablename]["schema"][field+".coordinates"]["#type"]="2dsphere";
               result[tablename]["viewmap"][field+".coordinates[1]"]=field+"_longitude";
               result[tablename]["viewmap"][field+".coordinates[2]"]=field+"_latitude";
           } else {
               var coords=fields.filter(function(z) { if (z.startsWith(field+".coordinates.")) return z; });
               for (var c in coords) { 
                  mschema[c]["#pgtype"]="numeric";
                  mschema[c]["#type"]="number";
               }
               result[tablename]["viewmap"][field+".coordinates[1]"]=field+".coordinates.lon";
               result[tablename]["viewmap"][field+".coordinates[2]"]=field+".coordinates.lat";
           }
           mschema[field+".type"]["#skip"]=true;
           mschema[field]["#skip"]=true;
           continue;
        }
        /* if it's an array, we will send the whole thing into prepSchema by itself */
        if ( currentfield.hasOwnProperty("#array") && currentfield["#array"] ) {
           debug("prepSchema: currentfield has #array=true field is " + field);
           delete(currentfield["#array"]);
           subtable=tablename+subsep+field;
           result[subtable]={};
           result[subtable]["parent_table"]=tablename;
           result[subtable]["pipe"]=[];
           result[subtable]["pipe"]=result[subtable]["pipe"].concat(result[tablename]["pipe"]);
           result[subtable]["pipe"].push({"$unwind":'$'+field});
           debug("Deep " + depth);
           debug(tojson(result[tablename]["pipe"]));
           debug(tojson(result[subtable]["pipe"]));
           result[subtable]["fieldmap"]={};
           fschema={}
           if (currentfield["#type"]=="object" || currentfield["#type"].hasOwnProperty("object") ) {
              fschema[field]={}
              fschema[field]["_id"]=mschema["_id"];
              fschema[field]["_id"]["#viewname"]=coll+"._id";
              for (var g in currentfield) 
                 if (currentfield.hasOwnProperty(g) && !g.startsWith("#")) 
                     fschema[field][field+"."+g]=currentfield[g]; 
              result=prepSchema(fschema[field], dbname, coll, subtable, result);
           } else {
              fschema["_id"]=mschema["_id"];
              fschema[field]=currentfield; 
              result=prepSchema(fschema, dbname, coll, subtable, result);
           }
           currentfield["#type"]="subtable";
           delete(currentfield);
           continue;
        }
        if (! currentfield.hasOwnProperty("#type")) throw "Field " + field + " does not have #type! just " + tojsononeline(currentfield);
        if (currentfield["#type"]=="object" || currentfield["#type"].hasOwnProperty("object") ) {  
           delete(currentfield);
           continue;
        }
        debug("prepSchema: left with field " + field + " currentfield is " + tojsononeline(currentfield));
        result[tablename]["schema"][field]={};
        for (var g in currentfield) {
           if (currentfield.hasOwnProperty(g)) result[tablename]["schema"][field][g]=currentfield[g];
        }
    }

    sch = result[tablename]["schema"];
    debug("prepSchema: Table is " + tablename);
    debug(tojson(sch));
    for (var f in sch) {
        if (!sch.hasOwnProperty(f)) continue;
        if (sch[f].hasOwnProperty("#skip")) continue;
        if (f.startsWith("#") || f.startsWith("__")) continue;
        /*  if the field name isn't legal postgres column then we need to add legal name */
        /*  also normalize dots and upper case to allow living without having to double quote */
        if ( replaceDots )
            newf=f.replace(/ /g,'').replace(/\./g,'_').toLowerCase().slice(0,62)
        else
            newf=f.replace(/ /g,'').toLowerCase().slice(0,62)
        if (newf!=f) {
           sch[f]["#pgname"]=newf;
        }
        if (typeof sch[f]["#type"] == "object") {
          types=[]
          typeobj=sch[f]["#type"];
          for (var g in typeobj) if (typeobj.hasOwnProperty(g)) types.push(g);
          type1=reduceType(types);
        } else 
          type1=sch[f]["#type"];
        sch[f]["#pgtype"]=mapType(type1);
        if (f.startsWith("Zip") || f.startsWith("zip")) sch[f]["#pgtype"]="varchar";

        // debug("field " + f + " was " + tojson(sch[f]["#type"]) + " but turned into " + sch[f]["#pgtype"] );

    }
    depth--;
    return result;
}

function generatePGSchema (tablename, pgschema) {
    print('DROP FOREIGN TABLE IF EXISTS "' + tablename + '_fdw" CASCADE;');
    print('DROP VIEW IF EXISTS "' + tablename + '" CASCADE;');

    print('CREATE FOREIGN TABLE "' + tablename + '_fdw" ( ', schema_stringify(pgschema.schema), " ) ");

    print("   SERVER " + mongodb_svr + " OPTIONS(" + databaseOption + " '" + pgschema.dbname + "', collection '" + pgschema.coll + "'");
    /* print("   SERVER " + mongodb_svr + " OPTIONS(db '" + pgschema.dbname + "', collection '" + pgschema.coll + "'"); */
    /* print(", fieldmap '", tojsononeline(pgschema.fieldmap), "'"); */
    if (pgschema.pipe.length> 0) print(", pipe '", tojsononeline(pgschema.pipe), "'");
    print(");" );
}

function generatePGView (tablename, pgschema) {
    print("-- view can be edited to transform field names further ");
    print("CREATE VIEW \"" + tablename + "\" AS SELECT *");
    print(" FROM \"" + tablename + "_fdw\";");
    print("");
}

function mergeIntoJoin(tschema, pschema) {
     var jschema = {};
     jschema["pipe"]= tschema["pipe"];
     jschema["dbname"]= tschema["dbname"];
     jschema["coll"]= tschema["coll"];
     jschema["schema"]= {}
     /* merge schema elements of t and parent of t */
     for (var f in tschema["schema"]) {
        if ( ! tschema["schema"].hasOwnProperty(f) ) continue;
         jschema["schema"][f] = tschema["schema"][f];
     }
     for (var f in pschema["schema"]) {
         if ( ! pschema["schema"].hasOwnProperty(f) ) continue;
         jschema["schema"][f] = pschema["schema"][f];
     }
     return jschema;
}
function makeSchema(dbname, coll, options) {

    // default options
    var options = options || {};
    debugOn=options.debug || false;
    doView=true;
    generateVirtual=true;
    generateJoin=true;
    replaceDots=true;
    if (options.view!=undefined) doView=options.view;
    if (options.virtual!=undefined) generateVirtual=options.virtual;
    if (options.join!=undefined) generateJoin=options.join;
    if (options.replaceDots!=undefined) replaceDots=options.replaceDots;
    sample = options.sample || 100;
    subsep=options.separator || "__";
    maxdepth=options.maxdepth || 50;
    includeFields=options.includeFields || [];
    excludeFields=options.excludeFields || [];
    schemaFilter=options.filter || null;
    mongodb_svr= options.serverName || "mongo_server";
    databaseOption= options.databaseOption || "db";

    debug("doView is " + doView + " options.view is " + options.view);

    if (excludeFields.length > 0 && includeFields.length > 0) throw "Only specify include or exclude fields, not both";
    if (includeFields.length > 0 && schemaFilter != null ) throw "Only specify include or schema filter, not both";

    if (schemaFilter != null) {
       includeFields = Object.keys(schemaFilter);
    }

    debug("makeSchema: " + databaseOption + " "+dbname + " coll " + coll + " sample " + sample + " debug " + debugOn + " view " + doView);

    colls=[];
    /* this function can be called for DB to make schema for every collection */
    if (coll == undefined) colls=db.getSiblingDB(dbname).getCollectionNames(); else 
    colls.push(coll);
    /* set error level onces */
    print('SET client_min_messages = error;');

    colls.forEach(function(c) {

       var cursor = db.getSiblingDB(dbname).getCollection(c).find({}, null, sample /* limit */, 0 /* skip*/, 0 /* batchSize */);

       opts={};
       opts={flat:true};
       var sch=schema(cursor, opts);

       geo2d=[];
       geo2dsphere=[];

       /* figure out if there are any geo fields */
       db.getSiblingDB(dbname).getCollection(c).getIndexes().forEach(function(i) { 
           if (i.name.endsWith("2d")) geo2d.push(firstKeyName(i.key)); 
           if (i.name.endsWith("2dsphere")) geo2dsphere.push(firstKeyName(i.key)); 
       });
   
       debug("makeSchema: Colling pschema with " + tojson(sch));
       /* transform contents of sch into result */
       pschema = prepSchema(sch, dbname, c);

       /* can keep doing this for other collections in this db */
       for (var t in pschema) {
          debug("t is " + t);
          debug(tojson(pschema[t]));
          if ( !pschema[t].hasOwnProperty("parent_table") || generateVirtual ) {
              generatePGSchema(t, pschema[t]);
              if (doView) generatePGView(t, pschema[t]);
          }
          if ( pschema[t].hasOwnProperty("parent_table") && generateJoin) {
             print('-- generating join table with parent --');
             parentTable=pschema[t]["parent_table"];
             tShortName=t.slice(t.indexOf(subsep)+subsep.length);
             joinT=parentTable+"_inner_join_"+tShortName;
             var ijschema = mergeIntoJoin( pschema[t], pschema[parentTable] );
             generatePGSchema(joinT, ijschema);
             if (doView) generatePGView(joinT, ijschema);
             /* check for double join */
             if ( pschema[parentTable].hasOwnProperty("parent_table")) {
                 var joinT2 = parentTable+"_inner_join_"+joinT;
                 var ijjschema = mergeIntoJoin( ijschema, pschema[pschema[parentTable]["parent_table"]]);
                 generatePGSchema(joinT2, ijjschema);
                 if (doView) generatePGView(joinT2, ijjschema);
             }
          }
       }
    });
}
/**
 * extend the DBCollection object to provide the .schema() method
 * 
 * @param {Object} options supports two options: {samples: 123, flat: true}
 *
 * @returns {Object} the schema document with counts ($c), types ($t),
 *                   an array flag ($a) and probability of occurrence
 *                   given the parent field ($p).
 */
if (typeof DBCollection !== 'undefined') {
    DBCollection.prototype.makeSchema = function(options) {
        
       return makeSchema(this._db.getName(), this._shortName, options);
    }

    DBCollection.prototype.schema = function(options) {
        
        // default options
        var options = options || {};
        options.samples = options.samples || 100;

        // limit of 0 means all documents
        if (options.samples === 'all') {
            options.samples = 0;
        }

        // get documents
        var cursor = this.find({}, null, options.samples /* limit */, 0 /* skip*/, 0 /* batchSize */);

        return schema(cursor, options);
    }
}
