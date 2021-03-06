doView=true;
debugOn=false;
depth=0;

debug = function (x) {
   if (debugOn) print("DEBUG: " + Array(depth).join('          ') + x);
}

var allTypes = {
    "none"     : -1,
    "geo"     : 0,
    "numeric[]"     : 0,
    "numeric" : 1,
    "boolean" : 2,
    "date"    : 3,
    "timestamp": 4,
    "varchar" : 5,
    "array"   : 6,
};

schema_to_view=function(sch) {
      sv='';  /* format is column, column, column as newname, etc */
      if (sch.hasOwnProperty("fieldmap")) fm=sch.fieldmap;
      var s=sch.schema;
      for (var f in s) {
         if (f.startsWith("#")) continue;
         if (!s.hasOwnProperty(f)) continue;
         if (!s[f].hasOwnProperty("#pgtype")) continue;
         if (s[f]["#type"]=="2d") {  /* maybe - if we already handled array vs. obj then just use pgname */
             sv = sv + " " + f + '[1] AS "' + f + '.lon", ' + f + '[2] AS "' + f + '.lat",'
         } else if (fm.hasOwnProperty(s[f]["#pgname"])) {
            sv = sv + " " + s[f]["#pgname"] + " AS " + fm[s[f]["#pgname"]] + ",";
         } else if ( f.startsWith("Zip") || f.startsWith("zip") ) {
             sv = sv + ' "' + f + '", ' + ' substr("' + f + '", 1, 5) ' + ' AS "' + f + '_trim5",';
         } else if (s[f]=="timestamp") {
             sv = sv + " " + f + ", " + f + "::date AS " + f + "_as_date,";
         } else {
             sv = sv + " " + JSON.stringify(f) + ",";
         }
      }
      return sv.slice(0,-1);
}

schema_stringify=function(s) {
      ss='';
      for (var f in s) {
         if (!s[f].hasOwnProperty("#pgtype")) continue;
         ss = ss + JSON.stringify(f) + " " + s[f]["#pgtype"] + ",";
      }
      return ss.slice(0,-1);
}


mapType = function ( t ) {
    debug("mapType: in type " + t);
    if (typeof(t) == "object" && t.hasOwnProperty("#type")) {
      ttype = firstKeyName(t);
      t=ttype;
    }
    debug("mapType: really type " + t);
    if ( [ "objectid", "text", "string", "category", "null" ].indexOf(t) >= 0 ) return "varchar";
    if ( [ "2d", "2dsphere" ].indexOf(t) >= 0 ) return "numeric[]";
    if ( [ "number" ].indexOf(t) >= 0 ) return "numeric";
    if ( [ "date" ].indexOf(t) >= 0 ) return "timestamp";
    if ( [ "boolean" ].indexOf(t) >= 0 ) return "boolean";
}

firstKeyName = function(o) {
    for (var propName in o) {
        if (o.hasOwnProperty(propName)) {
            return propName;
        }
    }
}

/* if passed in a list of types, then return dominant simple type out of it */
reduceType = function(types) {
     debug("reduceType: " + tojson(types));
     /* if not array or object ready to return */
     if (typeof(types)!="object") return types;
     debug("Types is " + tojson(types));
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

ifnull = function(f, n) {
    if (n==undefined) n=null;
    ifn={};
    ifn["$ifNull"]=[];
    (ifn["$ifNull"]).push(f);
    (ifn["$ifNull"]).push(n);
    return ifn;
}

ifempty = function(f, n) {
    if (n==undefined) n=0;
    ifc={};
    ifc["$cond"]=[];
    ifo={};
    ifo["$eq"]=[];
    ifo["$eq"].push(f);
    ifo["$eq"].push("");
    ifc["$cond"].push(ifo);
    ifc["$cond"].push(n);  /* maybe should be {"$literal":n} */
    ifc["$cond"].push(f);
    return ifc;
}

geo2d=[];
geo2dsphere=[];
arrays=[];

prepSchema = function(mschema, dbname, coll, tablename, result) {
    if (depth==0) topLevel=true;
    else topLevel=false;
    depth++;
    debug(tojson(mschema));

    if (tablename==coll) throw "cannot be passed in tablename same as collection name";
    if (tablename==undefined) tablename=coll;

    if (result==undefined) result={};
    if (!result.hasOwnProperty(tablename)) result[tablename]={};
    if (!result[tablename].hasOwnProperty("dbname")) result[tablename]["dbname"]=dbname;
    if (!result[tablename].hasOwnProperty("coll")) result[tablename]["coll"]=coll;
    if (!result[tablename].hasOwnProperty("schema")) result[tablename]["schema"]={};
    if (!result[tablename].hasOwnProperty("pipe")) result[tablename]["pipe"]=[];
    if (!result[tablename].hasOwnProperty("fieldmap")) result[tablename]["fieldmap"]={};

    debug("Depth is " + depth + " " + dbname + " " + tablename + " result is " + tojson(result));

    numRecords=mschema["#count"];

    var fields = Object.keys(mschema);
    for (var field in mschema) {
        if ( ! mschema.hasOwnProperty(field) ) continue;
        if ( '__schema' == field ) continue;  /* skip metadata */
        if ( field.startsWith("#") ) continue;  /* skip metadata */
        debug("doing field ********************** " + field);

        currentfield=mschema[field];
        
        if ( geo2d.indexOf(field) >= 0 ) {
           /* need to handle two element array differently from two field subdocument */
           debug(field + " is a 2d index geo field!!!");
           currentfield["#type"]="2d";
           if (currentfield["#array"]) {
              currentfield["#type"]="2darray";
              currentfield["#proj"]=ifnull("$"+field, [null,null]);
              delete(currentfield["#array"]);
              result[tablename]["schema"][field]=currentfield;
              result[tablename]["viewmap"][field+"[1]"]=field+".lon";
              result[tablename]["viewmap"][field+"[2]"]=field+".lat";
           } else {  /* must be object with two fields */
              var coords=fields.filter(function(z) { if (z.startsWith(field+".")) return z; });
              if (coords.length!=2) throw "Why would there more more than two coordinates for " + field + "? ";
              for (var c in coords) { 
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
           currentfield["#proj"]=ifnull("$"+field+".coordinates", [null,null]);
           debug("Going to delete " + field+".type and " + field+".coordinates fields");
           mschema[field+".type"]["#skip"]=true;
           mschema[field+".coordinates"]["#skip"]=true; // because we will use their values for top level?
           result[tablename]["schema"][field]=currentfield;
           result[tablename]["viewmap"][field+".coordinates[1]"]=field+".coordinates.lon";
           result[tablename]["viewmap"][field+".coordinates[2]"]=field+".coordinates.lat";
           continue;
        }
        /* if it's an array, we will send the whole thing into prepSchema by itself */
        if ( currentfield.hasOwnProperty("#array") && currentfield["#array"] ) {
           debug("currentfield has #array=true field is " + field);
           delete(currentfield["#array"]);
           subtable=tablename+"__"+field;
           result[subtable]={};
           result[subtable]["pipe"]=[];
           result[subtable]["pipe"].push({"$unwind":'$'+field});
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
        debug("left with field " + field + " currentfield is " + tojsononeline(currentfield));
        result[tablename]["schema"][field]={};
        for (var g in currentfield) {
           if (currentfield.hasOwnProperty(g)) result[tablename]["schema"][field][g]=currentfield[g];
        }
    }
    proj = {};
    proj["$project"] = {};
    pr = proj["$project"];
    needProj = false;

    sch = result[tablename]["schema"];
    debug("Table is " + tablename);
    debug(sch);
    for (var f in sch) {
        if (!sch.hasOwnProperty(f)) continue;
        if (sch[f].hasOwnProperty("#skip")) continue;
        if (f.startsWith("#") || f.startsWith("__")) continue;
        /*  unfinished - if the field name isn't legal postgres column then we need to do some hoop jumping */
        if (f.length>62) {
           newf=f.replace(/ /g,'').slice(0,62);
           sch[f]["#pgname"]=newf;
           if (!needProj) needProj=true;
           /* looks like we don't need this because we will already do proj of existing to newf pgname
           /* if ( !sch[f].hasOwnProperty("#proj") ) { 
              sch[f]["#proj"]={};
              sch[f]["#proj"][newf]="$"+f;
           } else {
              sch[f]["#proj"][newf]=f; // TEMPORARY - do we want whaever was in f's #proj ?
           } */
           result[tablename]["fieldmap"][newf]=f;
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

        prf="$"+f;
        if (sch[f].hasOwnProperty("#proj")) {
           prf=sch[f]["#proj"];
        } 

        if (f=="_id") continue;

        if (sch[f]["#pgtype"]!="varchar") {
           prf=ifnull(prf);
        } 
        if (sch[f]["#pgtype"]=="numeric") {
           prf=ifempty(prf);
        } 

        if (prf!="$"+f) {
           if (!needProj) needProj=true;
           pr[f]=prf;
        } else {
           pr[f]=1;
        }
    }
    if (needProj) {
        result[tablename]["pipe"].push(proj);
    }
    depth--;
    return result;
}

generatePGSchema = function(tablename, pgschema) {
    print("DROP FOREIGN TABLE IF EXISTS " + tablename + " CASCADE;");
    print("CREATE FOREIGN TABLE " + tablename + " ( ", schema_stringify(pgschema.schema), " ) ");
    print("     SERVER mongodb_srv OPTIONS(db '" + pgschema.dbname + "', collection '" + pgschema.coll + "'");
    if (pgschema.pipe.length> 0) print(", pipe '", tojsononeline(pgschema.pipe), "'");
    print(", fieldmap '", tojsononeline(pgschema.fieldmap), "'");
    print(");" );

    if (doView) {
       print("-- view can be edited to transform field names further ");
       print("CREATE VIEW " + tablename + "_view AS SELECT ");
       print(schema_to_view(pgschema));
       print(" FROM " + tablename + ";");
       print("");
    }

    pgpipe="";
}

doSchema = function (dbname, coll, sample, debugOpt, doViewOpt) {
    if (doViewOpt!=undefined) doView=doViewOpt; 
    if (debugOpt!=undefined) debugOn=debugOpt; 
    if (sample==undefined) sample=100;

    colls=[];
    if (coll == undefined) colls=db.getSiblingDB(dbname).getCollectionNames();
    else colls.push(coll);

    colls.forEach(function(c) {
       var sch=db.getSiblingDB(dbname).getCollection(coll).schema({flat:true});

       /* try to figure out if there are any geo fields */
       db.getSiblingDB(dbname).getCollection(c).getIndexes().forEach(function(i) { 
           if (i.name.endsWith("2d")) geo2d.push(firstKeyName(i.key)); 
           if (i.name.endsWith("2dsphere")) geo2dsphere.push(firstKeyName(i.key)); 
       });
   
       /* transform contents of sch into result */
       pschema = prepSchema(sch, dbname, c);

       /* can keep doing this for other collections in this db */
       for (var t in pschema) {
          generatePGSchema(t, pschema[t]);
       }
    });
}
