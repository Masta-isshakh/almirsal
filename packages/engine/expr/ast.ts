/** AST for the Python subset. Node names follow Python's own `ast` module. */

export type Node =
  | NumNode
  | StrNode
  | ConstNode
  | NameNode
  | TupleNode
  | ListNode
  | DictNode
  | SetNode
  | UnaryOpNode
  | BinOpNode
  | BoolOpNode
  | CompareNode
  | IfExpNode
  | CallNode
  | AttributeNode
  | SubscriptNode;

export interface NumNode { type: 'Num'; value: number }
export interface StrNode { type: 'Str'; value: string }
/** True / False / None */
export interface ConstNode { type: 'Const'; value: boolean | null }
export interface NameNode { type: 'Name'; id: string }
export interface TupleNode { type: 'Tuple'; elements: Node[] }
export interface ListNode { type: 'List'; elements: Node[] }
export interface SetNode { type: 'Set'; elements: Node[] }
export interface DictNode { type: 'Dict'; keys: Node[]; values: Node[] }

export type UnaryOperator = 'not' | '-' | '+' | '~';
export interface UnaryOpNode { type: 'UnaryOp'; op: UnaryOperator; operand: Node }

export type BinOperator = '+' | '-' | '*' | '/' | '//' | '%' | '**' | '|' | '&' | '^';
export interface BinOpNode { type: 'BinOp'; op: BinOperator; left: Node; right: Node }

export interface BoolOpNode { type: 'BoolOp'; op: 'and' | 'or'; values: Node[] }

export type CompareOperator =
  | '==' | '!=' | '<' | '<=' | '>' | '>='
  | 'in' | 'not in' | 'is' | 'is not';
/** Supports Python's chained comparisons: `0 < x <= 10`. */
export interface CompareNode {
  type: 'Compare';
  left: Node;
  ops: CompareOperator[];
  comparators: Node[];
}

export interface IfExpNode { type: 'IfExp'; body: Node; test: Node; orelse: Node }

export interface KeywordArg { name: string; value: Node }
export interface CallNode {
  type: 'Call';
  func: Node;
  args: Node[];
  keywords: KeywordArg[];
}

export interface AttributeNode { type: 'Attribute'; value: Node; attr: string }
export interface SubscriptNode { type: 'Subscript'; value: Node; index: Node }
