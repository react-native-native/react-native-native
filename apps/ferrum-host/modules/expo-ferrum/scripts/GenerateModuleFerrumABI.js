/**
 * Ferrum C ABI bridge generator for TurboModules.
 *
 * Reads the same JSON schema as react-native-codegen and emits C ABI bridge
 * functions that call ObjC methods directly via objc_msgSend — zero JSI in
 * the call path.
 *
 * Conforms to RNCodegen's GenerateFunction signature:
 *   (libraryName, schema, packageName, assumeNonnull, headerPrefix) => Map<filename, content>
 *
 * @flow strict
 * @format
 */

'use strict';

const {unwrapNullable} = require(
  '@react-native/codegen/lib/parsers/parsers-commons',
);
const {getModules} = require(
  '@react-native/codegen/lib/generators/modules/Utils',
);

// ---------------------------------------------------------------------------
// Arg conversion: HermesABIValue → ObjC type
// ---------------------------------------------------------------------------

function abiArgExtraction(
  typeName /*: string */,
  argIndex /*: number */,
  nullable /*: boolean */,
  optional /*: boolean */,
) /*: string */ {
  const val = `args[${argIndex}]`;

  // Nullable / optional wrapper
  const wrapNullCheck = (expr) => {
    if (nullable || optional) {
      return `(ferrum_abi_is_null_or_undefined(&${val}) ? nil : ${expr})`;
    }
    return expr;
  };

  switch (typeName) {
    case 'BooleanTypeAnnotation':
    case 'BooleanLiteralTypeAnnotation':
      if (nullable || optional) {
        return wrapNullCheck(`@(ferrum_abi_get_bool(&${val}))`);
      }
      return `ferrum_abi_get_bool(&${val})`;

    case 'NumberTypeAnnotation':
    case 'FloatTypeAnnotation':
    case 'DoubleTypeAnnotation':
    case 'NumberLiteralTypeAnnotation':
      if (nullable || optional) {
        return wrapNullCheck(`@(ferrum_abi_get_number(&${val}))`);
      }
      return `ferrum_abi_get_number(&${val})`;

    case 'Int32TypeAnnotation':
      if (nullable || optional) {
        return wrapNullCheck(`@((NSInteger)ferrum_abi_get_number(&${val}))`);
      }
      return `(NSInteger)ferrum_abi_get_number(&${val})`;

    case 'StringTypeAnnotation':
    case 'StringLiteralTypeAnnotation':
      return wrapNullCheck(
        `ferrum_abi_get_string(abiRt, vt, &${val})`,
      );

    case 'GenericObjectTypeAnnotation':
      return wrapNullCheck(
        `ferrum_abi_get_object(abiRt, vt, &${val})`,
      );

    case 'ArrayTypeAnnotation':
      return wrapNullCheck(
        `ferrum_abi_get_array(abiRt, vt, &${val})`,
      );

    case 'FunctionTypeAnnotation':
      return `ferrum_abi_wrap_callback(abiRt, vt, &${val}, ferrum_get_js_invoker())`;

    case 'ObjectTypeAnnotation':
      return wrapNullCheck(
        `ferrum_abi_get_object(abiRt, vt, &${val})`,
      );

    default:
      // Fallback — unsupported type, skip this method
      return null;
  }
}

// ---------------------------------------------------------------------------
// Return conversion: ObjC result → HermesABIValue
// ---------------------------------------------------------------------------

function abiReturnConversion(returnJSType /*: string */) /*: {before: string, after: string} */ {
  switch (returnJSType) {
    case 'VoidKind':
      return {
        before: '',
        after: 'return ferrum_abi_make_undefined();',
      };
    case 'BooleanKind':
      return {
        before: 'id result = ',
        after: `return ferrum_abi_from_bool([result boolValue]);`,
      };
    case 'NumberKind':
      return {
        before: 'id result = ',
        after: `return ferrum_abi_from_number([result doubleValue]);`,
      };
    case 'StringKind':
      return {
        before: 'NSString *result = ',
        after: `return ferrum_abi_from_string(abiRt, vt, result);`,
      };
    case 'ObjectKind':
      return {
        before: 'id result = ',
        after: `return ferrum_abi_from_object(abiRt, vt, result);`,
      };
    case 'ArrayKind':
      return {
        before: 'id result = ',
        after: `return ferrum_abi_from_object(abiRt, vt, result);`,
      };
    case 'PromiseKind':
      // Promises need special handling — skip for now
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// ObjC type mapping for protocol declarations
// ---------------------------------------------------------------------------

function objcParamType(typeName, nullable, optional) {
  if (nullable || optional) {
    switch (typeName) {
      case 'BooleanTypeAnnotation':
      case 'BooleanLiteralTypeAnnotation':
        return 'NSNumber *';
      case 'NumberTypeAnnotation':
      case 'FloatTypeAnnotation':
      case 'DoubleTypeAnnotation':
      case 'NumberLiteralTypeAnnotation':
      case 'Int32TypeAnnotation':
        return 'NSNumber *';
      default:
        break;
    }
  }
  switch (typeName) {
    case 'BooleanTypeAnnotation':
    case 'BooleanLiteralTypeAnnotation':
      return 'BOOL';
    case 'NumberTypeAnnotation':
    case 'FloatTypeAnnotation':
    case 'DoubleTypeAnnotation':
    case 'NumberLiteralTypeAnnotation':
      return 'double';
    case 'Int32TypeAnnotation':
      return 'NSInteger';
    case 'StringTypeAnnotation':
    case 'StringLiteralTypeAnnotation':
      return 'NSString *';
    case 'GenericObjectTypeAnnotation':
    case 'ObjectTypeAnnotation':
      return 'NSDictionary *';
    case 'ArrayTypeAnnotation':
      return 'NSArray *';
    case 'FunctionTypeAnnotation':
      return 'FerrumCallbackBlock';
    default:
      return 'id';
  }
}

function objcReturnType(returnJSType) {
  switch (returnJSType) {
    case 'VoidKind': return 'void';
    case 'BooleanKind': return 'NSNumber *';
    case 'NumberKind': return 'NSNumber *';
    case 'StringKind': return 'NSString *';
    case 'ObjectKind': return 'NSDictionary *';
    case 'ArrayKind': return 'NSArray *';
    default: return 'id';
  }
}

// ---------------------------------------------------------------------------
// Method bridge generation
// ---------------------------------------------------------------------------

function generateMethodBridge(
  hasteModuleName /*: string */,
  methodName /*: string */,
  selector /*: string */,
  returnJSType /*: string */,
  params /*: $ReadOnlyArray<{name: string, typeAnnotation: any}> */,
  resolveAlias /*: any */,
) /*: string | null */ {
  // Skip async methods (promises) for now
  if (returnJSType === 'PromiseKind') {
    return null;
  }

  // Skip getConstants — complex return type
  if (methodName === 'getConstants' || methodName === 'constantsToExport') {
    return null;
  }

  // Build arg extractions
  const argExtractions = [];
  const argNames = [];

  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    let typeAnnotation = param.typeAnnotation;
    const [unwrapped, nullable] = unwrapNullable(typeAnnotation);

    let realType = unwrapped;
    if (realType.type === 'TypeAliasTypeAnnotation') {
      // Complex struct type — skip for now
      return null;
    }

    const extraction = abiArgExtraction(
      realType.type,
      i,
      nullable,
      param.optional || false,
    );

    if (extraction === null) {
      // Unsupported arg type — skip this method
      return null;
    }

    const argVarName = `arg${i}`;
    argExtractions.push(`  auto ${argVarName} = ${extraction};`);
    argNames.push(argVarName);
  }

  // Build return conversion
  const ret = abiReturnConversion(returnJSType);
  if (ret === null) {
    return null;
  }

  // Build the ObjC message send
  // selector looks like: @selector(methodName:param1:param2:)
  // We need to build [instance methodName:arg0 param1:arg1 param2:arg2]
  const selectorStr = selector.replace('@selector(', '').replace(')', '');
  const selectorParts = selectorStr.split(':').filter(s => s.length > 0);

  let msgSend;
  if (argNames.length === 0) {
    msgSend = `[instance ${methodName}]`;
  } else {
    const parts = selectorParts.map((part, i) => {
      return i === 0
        ? `${part}:${argNames[i]}`
        : ` ${part}:${argNames[i]}`;
    });
    msgSend = `[instance ${parts.join('')}]`;
  }

  // For void returns (async methods), dispatch to the module's method queue.
  // This replicates what invokeObjCMethod does for VoidKind.
  const invocation = returnJSType === 'VoidKind'
    ? `  dispatch_queue_t queue = [(id)instance respondsToSelector:@selector(methodQueue)]
      ? [(id<RCTBridgeModule>)instance methodQueue] : dispatch_get_main_queue();
  dispatch_async(queue, ^{ ${msgSend}; });`
    : `  ${ret.before}${msgSend};`;

  return `
// ${hasteModuleName}.${methodName}
static HermesABIValueOrError ferrum_${hasteModuleName}_${methodName}(
    void *ctx,
    HermesABIRuntime *abiRt,
    const HermesABIRuntimeVTable *vt,
    const HermesABIValue *thisArg,
    const HermesABIValue *args,
    size_t count) {
  id<Ferrum_${hasteModuleName}_ABI> instance = (__bridge id<Ferrum_${hasteModuleName}_ABI>)ctx;
${argExtractions.join('\n')}
${invocation}
  ${ret.after}
}`;
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

function generateModuleRegistration(
  hasteModuleName /*: string */,
  moduleName /*: string */,
  methods /*: $ReadOnlyArray<{methodName: string, argCount: number}> */,
) /*: string */ {
  const entries = methods.map(({methodName, argCount}) => {
    return `    {"${methodName}", ${argCount}, ferrum_${hasteModuleName}_${methodName}},`;
  });

  // Use hasteModuleName for C identifiers, moduleName for the registry string.
  // The macro stringifies the first arg, so we use a raw string call instead.
  return `
static const FerrumABIBridgeEntry ferrum_${hasteModuleName}_bridges[] = {
${entries.join('\n')}
    {nullptr, 0, nullptr}, // sentinel
};

__attribute__((constructor))
static void ferrum_register_${hasteModuleName}_bridges(void) {
  ferrum_abi_register_module("${moduleName}", ferrum_${hasteModuleName}_bridges);
}`;
}

// ---------------------------------------------------------------------------
// Main generator (conforms to RNCodegen GenerateFunction signature)
// ---------------------------------------------------------------------------

function generate(
  libraryName /*: string */,
  schema /*: any */,
  packageName /*: ?string */,
  assumeNonnull /*: boolean */,
  headerPrefix /*: ?string */,
) /*: Map<string, string> */ {
  const nativeModules = getModules(schema);
  const output = new Map();

  const allBridges = [];
  const allRegistrations = [];

  const hasteModuleNames = Object.keys(nativeModules).sort();
  for (const hasteModuleName of hasteModuleNames) {
    const {excludedPlatforms, spec, moduleName: registryName} = nativeModules[hasteModuleName];
    // Use the actual module name (e.g., "RNCAsyncStorage") for the registry,
    // falling back to the haste name if not specified.
    const moduleName = registryName || hasteModuleName;
    if (excludedPlatforms != null && excludedPlatforms.includes('iOS')) {
      continue;
    }

    const methodBridges = [];
    const registeredMethods = [];
    const protocolMethods = [];

    for (const property of spec.methods) {
      const {name: methodName, typeAnnotation: nullableTypeAnnotation} =
        property;
      const [propertyTypeAnnotation] = unwrapNullable(nullableTypeAnnotation);
      const {params} = propertyTypeAnnotation;

      // Get selector (same logic as serializeMethod.js)
      const methodParams = [];
      for (const param of params) {
        methodParams.push(param.name);
      }

      // Build ObjC selector
      let selectorStr;
      if (methodParams.length === 0) {
        selectorStr = methodName;
      } else {
        selectorStr = methodParams.reduce((sel, paramName, i) => {
          return i === 0 ? `${sel}:` : `${sel}${paramName}:`;
        }, methodName);
      }
      const selector = `@selector(${selectorStr})`;

      // Get return type
      const [returnTypeAnnotation] = unwrapNullable(
        propertyTypeAnnotation.returnTypeAnnotation,
      );

      let returnJSType = 'VoidKind';
      switch (returnTypeAnnotation.type) {
        case 'VoidTypeAnnotation':
          returnJSType = 'VoidKind';
          break;
        case 'BooleanTypeAnnotation':
        case 'BooleanLiteralTypeAnnotation':
          returnJSType = 'BooleanKind';
          break;
        case 'NumberTypeAnnotation':
        case 'FloatTypeAnnotation':
        case 'DoubleTypeAnnotation':
        case 'Int32TypeAnnotation':
        case 'NumberLiteralTypeAnnotation':
          returnJSType = 'NumberKind';
          break;
        case 'StringTypeAnnotation':
        case 'StringLiteralTypeAnnotation':
          returnJSType = 'StringKind';
          break;
        case 'PromiseTypeAnnotation':
          returnJSType = 'PromiseKind';
          break;
        case 'ObjectTypeAnnotation':
        case 'TypeAliasTypeAnnotation':
        case 'GenericObjectTypeAnnotation':
          returnJSType = 'ObjectKind';
          break;
        case 'ArrayTypeAnnotation':
          returnJSType = 'ArrayKind';
          break;
        default:
          returnJSType = 'VoidKind';
      }

      const bridge = generateMethodBridge(
        hasteModuleName,
        methodName,
        selector,
        returnJSType,
        params,
        null,
      );

      if (bridge !== null) {
        methodBridges.push(bridge);
        registeredMethods.push({
          methodName,
          argCount: params.length,
        });

        // Build ObjC protocol method declaration
        const retType = objcReturnType(returnJSType);
        const selectorParts2 = selectorStr.split(':').filter(s => s.length > 0);
        if (params.length === 0) {
          protocolMethods.push(`- (${retType})${methodName};`);
        } else {
          const paramDecls = selectorParts2.map((part, pi) => {
            const param = params[pi];
            const [unwrapped2, nullable2] = unwrapNullable(param.typeAnnotation);
            const pType = objcParamType(unwrapped2.type, nullable2, param.optional || false);
            return pi === 0
              ? `${part}:(${pType})arg${pi}`
              : ` ${part}:(${pType})arg${pi}`;
          });
          protocolMethods.push(`- (${retType})${paramDecls.join('')};`);
        }
      }
    }

    if (methodBridges.length > 0) {
      allBridges.push(
        `// Protocol for ${hasteModuleName} — tells compiler the method signatures\n` +
        `@protocol Ferrum_${hasteModuleName}_ABI\n` +
        protocolMethods.join('\n') + '\n' +
        `@end\n` +
        methodBridges.join('\n'),
      );
      allRegistrations.push(
        generateModuleRegistration(hasteModuleName, moduleName, registeredMethods),
      );
    }
  }

  if (allBridges.length === 0) {
    return output;
  }

  const sourceFile = `/**
 * Generated by Ferrum C ABI codegen.
 * Do not edit — changes will be overwritten.
 *
 * @generated by GenerateModuleFerrumABI
 */

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#include <hermes_abi/hermes_abi.h>  // must come before Ferrum headers
#import "FerrumABIHelpers.h"
#import "FerrumABIRegistry.h"

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wundeclared-selector"
#pragma clang diagnostic ignored "-Wobjc-method-access"

${allBridges.join('\n')}

${allRegistrations.join('\n')}

// Dummy ObjC class so -ObjC linker flag forces inclusion of this translation unit
@interface FerrumABIBridge_${libraryName} : NSObject @end
@implementation FerrumABIBridge_${libraryName} @end

#pragma clang diagnostic pop
`;

  output.set(`${libraryName}-ferrum-abi.mm`, sourceFile);
  return output;
}

module.exports = {generate};
