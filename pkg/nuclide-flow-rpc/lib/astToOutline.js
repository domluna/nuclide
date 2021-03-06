/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 */

import type {FlowOutlineTree, Point} from '..';
import {arrayCompact} from '../../commons-node/collection';

import type {TokenizedText} from '../../commons-node/tokenizedText-rpc-types';
import {
  keyword,
  className,
  method,
  param,
  string,
  whitespace,
  plain,
  type,
} from '../../commons-node/tokenizedText';

import invariant from 'assert';

type Extent = {
  startPosition: Point,
  endPosition: Point,
};

export function astToOutline(ast: any): Array<FlowOutlineTree> {
  return itemsToTrees(ast.body);
}

function itemsToTrees(items: Array<any>): Array<FlowOutlineTree> {
  return arrayCompact(items.map(itemToTree));
}

function itemToTree(item: any): ?FlowOutlineTree {
  if (item == null) {
    return null;
  }
  const extent = getExtent(item);
  switch (item.type) {
    case 'FunctionDeclaration':
      return functionOutline(item.id.name, item.params, extent);
    case 'ClassDeclaration':
    case 'ClassExpression':
      const tokenizedText = [keyword('class')];
      let representativeName = undefined;
      if (item.id != null) {
        tokenizedText.push(whitespace(' '), className(item.id.name));
        representativeName = item.id.name;
      }
      return {
        tokenizedText,
        representativeName,
        children: itemsToTrees(item.body.body),
        ...extent,
      };
    case 'ClassProperty':
      let paramTokens = [];
      if (item.value && item.value.type === 'ArrowFunctionExpression') {
        paramTokens = [
          plain('('),
          ...declarationsTokenizedText(item.value.params),
          plain(')'),
        ];
      }
      return {
        tokenizedText: [
          method(item.key.name),
          plain('='),
          ...paramTokens,
        ],
        representativeName: item.key.name,
        children: [],
        ...extent,
      };
    case 'MethodDefinition':
      return {
        tokenizedText: [
          method(item.key.name),
          plain('('),
          ...declarationsTokenizedText(item.value.params),
          plain(')'),
        ],
        representativeName: item.key.name,
        children: [],
        ...extent,
      };
    case 'ExportDeclaration':
    case 'ExportNamedDeclaration':
      return exportDeclaration(item, extent, Boolean(item.default));
    case 'ExportDefaultDeclaration':
      return exportDeclaration(item, extent, true);
    case 'ExpressionStatement':
      return topLevelExpressionOutline(item);
    case 'TypeAlias':
      return typeAliasOutline(item);
    case 'VariableDeclaration':
      return variableDeclarationOutline(item);
    default:
      return null;
  }
}

function exportDeclaration(
  item: any,
  extent: Extent,
  isDefault: boolean,
): ?FlowOutlineTree {
  const tree = itemToTree(item.declaration);
  if (tree == null) {
    return null;
  }
  const tokenizedText = [keyword('export'), whitespace(' ')];
  if (isDefault) {
    tokenizedText.push(keyword('default'), whitespace(' '));
  }
  tokenizedText.push(...tree.tokenizedText);
  return {
    tokenizedText,
    representativeName: tree.representativeName,
    children: tree.children,
    ...extent,
  };
}

function declarationReducer(
  textElements: TokenizedText,
  p: any,
  index: number,
  declarations: Array<any>,
): TokenizedText {
  switch (p.type) {
    case 'Identifier':
      textElements.push(param(p.name));
      break;
    case 'ObjectPattern':
      textElements.push(plain('{'));
      textElements.push(...declarationsTokenizedText(p.properties.map(obj => obj.key)));
      textElements.push(plain('}'));
      break;
    case 'ArrayPattern':
      textElements.push(plain('['));
      textElements.push(...declarationsTokenizedText(p.elements));
      textElements.push(plain(']'));
      break;
    case 'AssignmentPattern':
      return declarationReducer(textElements, p.left, index, declarations);
    case 'RestElement':
      textElements.push(plain('...'));
      return declarationReducer(textElements, p.argument, index, declarations);
    default:
      throw new Error(`encountered unexpected argument type ${p.type}`);
  }
  if (index < declarations.length - 1) {
    textElements.push(plain(','));
    textElements.push(whitespace(' '));
  }
  return textElements;
}

function declarationsTokenizedText(declarations: Array<any>): TokenizedText {
  return declarations.reduce(declarationReducer, []);
}

function getExtent(item: any): Extent {
  return {
    startPosition: {
      // It definitely makes sense that the lines we get are 1-based and the columns are
      // 0-based... convert to 0-based all around.
      line: item.loc.start.line - 1,
      column: item.loc.start.column,
    },
    endPosition: {
      line: item.loc.end.line - 1,
      column: item.loc.end.column,
    },
  };
}

function functionOutline(name: string, params: Array<any>, extent: Extent): FlowOutlineTree {
  return {
    tokenizedText: [
      keyword('function'),
      whitespace(' '),
      method(name),
      plain('('),
      ...declarationsTokenizedText(params),
      plain(')'),
    ],
    representativeName: name,
    children: [],
    ...extent,
  };
}

function typeAliasOutline(typeAliasExpression: any): FlowOutlineTree {
  invariant(typeAliasExpression.type === 'TypeAlias');
  const name = typeAliasExpression.id.name;
  return {
    tokenizedText: [
      keyword('type'),
      whitespace(' '),
      type(name),
    ],
    representativeName: name,
    children: [],
    ...getExtent(typeAliasExpression),
  };
}

function topLevelExpressionOutline(expressionStatement: any): ?FlowOutlineTree {
  switch (expressionStatement.expression.type) {
    case 'CallExpression':
      return specOutline(expressionStatement, /* describeOnly */ true);
    case 'AssignmentExpression':
      return moduleExportsOutline(expressionStatement.expression);
    default:
      return null;
  }
}

function moduleExportsOutline(assignmentStatement: any): ?FlowOutlineTree {
  invariant(assignmentStatement.type === 'AssignmentExpression');

  const left = assignmentStatement.left;
  if (!isModuleExports(left)) {
    return null;
  }

  const right = assignmentStatement.right;
  if (right.type !== 'ObjectExpression') {
    return null;
  }
  const properties: Array<Object> = right.properties;
  return {
    tokenizedText: [plain('module.exports')],
    children: arrayCompact(properties.map(moduleExportsPropertyOutline)),
    ...getExtent(assignmentStatement),
  };
}

function isModuleExports(left: Object): boolean {
  return left.type === 'MemberExpression' &&
    left.object.type === 'Identifier' &&
    left.object.name === 'module' &&
    left.property.type === 'Identifier' &&
    left.property.name === 'exports';
}

function moduleExportsPropertyOutline(property: any): ?FlowOutlineTree {
  invariant(property.type === 'Property');
  if (property.key.type !== 'Identifier') {
    return null;
  }
  const propName = property.key.name;

  if (property.shorthand) {
    // This happens when the shorthand `{ foo }` is used for `{ foo: foo }`
    return {
      tokenizedText: [
        string(propName),
      ],
      representativeName: propName,
      children: [],
      ...getExtent(property),
    };
  }

  if (property.value.type === 'FunctionExpression' ||
    property.value.type === 'ArrowFunctionExpression'
  ) {
    return {
      tokenizedText: [
        method(propName),
        plain('('),
        ...declarationsTokenizedText(property.value.params),
        plain(')'),
      ],
      representativeName: propName,
      children: [],
      ...getExtent(property),
    };
  }

  return {
    tokenizedText: [
      string(propName),
      plain(':'),
    ],
    representativeName: propName,
    children: [],
    ...getExtent(property),
  };
}

function specOutline(expressionStatement: any, describeOnly: boolean = false): ?FlowOutlineTree {
  const expression = expressionStatement.expression;
  if (expression.type !== 'CallExpression') {
    return null;
  }
  const functionName = getFunctionName(expression.callee);
  if (functionName == null) {
    return null;
  }
  if (!isDescribe(functionName)) {
    if (describeOnly || !isIt(functionName)) {
      return null;
    }
  }
  const description = getStringLiteralValue(expression.arguments[0]);
  const specBody = getFunctionBody(expression.arguments[1]);
  if (description == null || specBody == null) {
    return null;
  }
  let children;
  if (isIt(functionName)) {
    children = [];
  } else {
    children = arrayCompact(
      specBody
      .filter(item => item.type === 'ExpressionStatement')
      .map(item => specOutline(item)));
  }
  return {
    tokenizedText: [
      method(functionName),
      whitespace(' '),
      string(description),
    ],
    representativeName: description,
    children,
    ...getExtent(expressionStatement),
  };
}

// Return the function name as written as a string. Intended to stringify patterns like `describe`
// and `describe.only` even though `describe.only` is a MemberExpression rather than an Identifier.
function getFunctionName(callee: any): ?string {
  switch (callee.type) {
    case 'Identifier':
      return callee.name;
    case 'MemberExpression':
      if (callee.object.type !== 'Identifier' || callee.property.type !== 'Identifier') {
        return null;
      }
      return `${callee.object.name}.${callee.property.name}`;
    default:
      return null;
  }
}

function isDescribe(functionName: string): boolean {
  switch (functionName) {
    case 'describe':
    case 'fdescribe':
    case 'ddescribe':
    case 'xdescribe':
    case 'describe.only':
    case 'describe.skip':
      return true;
    default:
      return false;
  }
}

function isIt(functionName: string): boolean {
  switch (functionName) {
    case 'it':
    case 'fit':
    case 'iit':
    case 'pit':
    case 'xit':
    case 'it.only':
    case 'it.skip':
      return true;
    default:
      return false;
  }
}

/** If the given AST Node is a string literal, return its literal value. Otherwise return null */
function getStringLiteralValue(literal: ?any): ?string {
  if (literal == null) {
    return null;
  }
  if (literal.type !== 'Literal') {
    return null;
  }
  const value = literal.value;
  if (typeof value !== 'string') {
    return null;
  }
  return value;
}

function getFunctionBody(fn: ?any): ?Array<any> {
  if (fn == null) {
    return null;
  }
  if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') {
    return null;
  }
  return fn.body.body;
}

function variableDeclarationOutline(declaration: any): ?FlowOutlineTree {
  // If there are multiple var declarations in one line, just take the first.
  return variableDeclaratorOutline(
           declaration.declarations[0],
           declaration.kind,
           getExtent(declaration),
         );
}

function variableDeclaratorOutline(
  declarator: any,
  kind: string,
  extent: Extent,
): ?FlowOutlineTree {
  if (declarator.init != null && (declarator.init.type === 'FunctionExpression'
      || declarator.init.type === 'ArrowFunctionExpression')) {
    return functionOutline(declarator.id.name, declarator.init.params, extent);
  }

  const {id} = declarator;


  const tokenizedText = [
    keyword(kind),
    whitespace(' '),
    ...declarationsTokenizedText([id]),
  ];
  const representativeName = id.type === 'Identifier' ? id.name : undefined;
  return {
    tokenizedText,
    representativeName,
    children: [],
    ...extent,
  };
}
