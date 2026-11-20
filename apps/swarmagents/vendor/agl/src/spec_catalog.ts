export interface SpecItem {
  id: string;
  level: number;
  op: string;
  category: string;
  description: string;
  expectedArgs: string[];
  sampleInputs: Record<string, any>[];
  fuzzValidator: (val: any, inputs: Record<string, any>) => boolean;
}

export const AGL_SPEC_CATALOG: SpecItem[] = [
  // --- LEVEL 0: MATHEMATICS & NUMERICS ---
  {
    id: "l0_math_abs",
    level: 0,
    op: "abs",
    category: "math",
    description: "Absolute value: if $a < 0 return (0 - $a) else $a",
    expectedArgs: ["$a"],
    sampleInputs: [{ $a: -12 }, { $a: 42 }, { $a: -0.5 }, { $a: 0 }],
    fuzzValidator: (val, inp) => val === Math.abs(inp.$a)
  },
  {
    id: "l0_math_neg",
    level: 0,
    op: "neg",
    category: "math",
    description: "Negate value: return (0 - $a)",
    expectedArgs: ["$a"],
    sampleInputs: [{ $a: 5 }, { $a: -8 }, { $a: 0 }],
    fuzzValidator: (val, inp) => val === -inp.$a
  },
  {
    id: "l0_math_min",
    level: 0,
    op: "min",
    category: "math",
    description: "Minimum of two numbers: if $a < $b return $a else $b",
    expectedArgs: ["$a", "$b"],
    sampleInputs: [{ $a: 10, $b: 20 }, { $a: 99, $b: -5 }, { $a: 7, $b: 7 }],
    fuzzValidator: (val, inp) => val === Math.min(inp.$a, inp.$b)
  },
  {
    id: "l0_math_max",
    level: 0,
    op: "max",
    category: "math",
    description: "Maximum of two numbers: if $a > $b return $a else $b",
    expectedArgs: ["$a", "$b"],
    sampleInputs: [{ $a: 10, $b: 20 }, { $a: -5, $b: -10 }, { $a: 3, $b: 3 }],
    fuzzValidator: (val, inp) => val === Math.max(inp.$a, inp.$b)
  },
  {
    id: "l0_math_clamp",
    level: 0,
    op: "clamp",
    category: "math",
    description: "Clamp $x between $min and $max: if $x < $min return $min else (if $x > $max return $max else $x)",
    expectedArgs: ["$x", "$min", "$max"],
    sampleInputs: [{ $x: -5, $min: 0, $max: 10 }, { $x: 15, $min: 0, $max: 10 }, { $x: 4, $min: 0, $max: 10 }],
    fuzzValidator: (val, inp) => val === Math.max(inp.$min, Math.min(inp.$max, inp.$x))
  },
  {
    id: "l0_math_sqr",
    level: 0,
    op: "sqr",
    category: "math",
    description: "Square number: return ($a * $a)",
    expectedArgs: ["$a"],
    sampleInputs: [{ $a: 3 }, { $a: -4 }, { $a: 10 }],
    fuzzValidator: (val, inp) => val === inp.$a * inp.$a
  },
  {
    id: "l0_math_inc",
    level: 0,
    op: "inc",
    category: "math",
    description: "Increment by 1: return ($a + 1)",
    expectedArgs: ["$a"],
    sampleInputs: [{ $a: 0 }, { $a: 19 }, { $a: -5 }],
    fuzzValidator: (val, inp) => val === inp.$a + 1
  },
  {
    id: "l0_math_dec",
    level: 0,
    op: "dec",
    category: "math",
    description: "Decrement by 1: return ($a - 1)",
    expectedArgs: ["$a"],
    sampleInputs: [{ $a: 10 }, { $a: 1 }, { $a: -2 }],
    fuzzValidator: (val, inp) => val === inp.$a - 1
  },
  {
    id: "l0_math_diff",
    level: 0,
    op: "diff",
    category: "math",
    description: "Absolute difference: abs($a - $b)",
    expectedArgs: ["$a", "$b"],
    sampleInputs: [{ $a: 15, $b: 25 }, { $a: 30, $b: 10 }],
    fuzzValidator: (val, inp) => val === Math.abs(inp.$a - inp.$b)
  },
  {
    id: "l0_math_avg",
    level: 0,
    op: "avg",
    category: "math",
    description: "Average of two numbers: return ($a + $b) / 2",
    expectedArgs: ["$a", "$b"],
    sampleInputs: [{ $a: 10, $b: 20 }, { $a: 4, $b: 6 }, { $a: 0, $b: 10 }],
    fuzzValidator: (val, inp) => val === (inp.$a + inp.$b) / 2
  },

  // --- LEVEL 0: BOOLEAN & PREDICATES ---
  {
    id: "l0_bool_and",
    level: 0,
    op: "and",
    category: "logic",
    description: "Logical AND: if $a return $b else false",
    expectedArgs: ["$a", "$b"],
    sampleInputs: [{ $a: true, $b: true }, { $a: true, $b: false }, { $a: false, $b: true }, { $a: false, $b: false }],
    fuzzValidator: (val, inp) => Boolean(val) === (Boolean(inp.$a) && Boolean(inp.$b))
  },
  {
    id: "l0_bool_or",
    level: 0,
    op: "or",
    category: "logic",
    description: "Logical OR: if $a return true else $b",
    expectedArgs: ["$a", "$b"],
    sampleInputs: [{ $a: true, $b: false }, { $a: false, $b: false }, { $a: false, $b: true }],
    fuzzValidator: (val, inp) => Boolean(val) === (Boolean(inp.$a) || Boolean(inp.$b))
  },
  {
    id: "l0_bool_xor",
    level: 0,
    op: "xor",
    category: "logic",
    description: "Logical XOR: true if exactly one operand is true",
    expectedArgs: ["$a", "$b"],
    sampleInputs: [{ $a: true, $b: false }, { $a: true, $b: true }, { $a: false, $b: false }],
    fuzzValidator: (val, inp) => Boolean(val) === (Boolean(inp.$a) !== Boolean(inp.$b))
  },
  {
    id: "l0_bool_gte",
    level: 0,
    op: "gte",
    category: "logic",
    description: "Greater than or equal: not($a < $b)",
    expectedArgs: ["$a", "$b"],
    sampleInputs: [{ $a: 5, $b: 3 }, { $a: 5, $b: 5 }, { $a: 2, $b: 5 }],
    fuzzValidator: (val, inp) => Boolean(val) === (inp.$a >= inp.$b)
  },
  {
    id: "l0_bool_lte",
    level: 0,
    op: "lte",
    category: "logic",
    description: "Less than or equal: not($a > $b)",
    expectedArgs: ["$a", "$b"],
    sampleInputs: [{ $a: 2, $b: 5 }, { $a: 5, $b: 5 }, { $a: 7, $b: 5 }],
    fuzzValidator: (val, inp) => Boolean(val) === (inp.$a <= inp.$b)
  },
  {
    id: "l0_bool_neq",
    level: 0,
    op: "neq",
    category: "logic",
    description: "Not equal: not($a == $b)",
    expectedArgs: ["$a", "$b"],
    sampleInputs: [{ $a: 10, $b: 20 }, { $a: 5, $b: 5 }, { $a: "hi", $b: "hi" }, { $a: "a", $b: "b" }],
    fuzzValidator: (val, inp) => Boolean(val) === (inp.$a !== inp.$b)
  },
  {
    id: "l0_bool_is_zero",
    level: 0,
    op: "is_zero",
    category: "logic",
    description: "Check if number equals 0",
    expectedArgs: ["$a"],
    sampleInputs: [{ $a: 0 }, { $a: 1 }, { $a: -5 }],
    fuzzValidator: (val, inp) => Boolean(val) === (inp.$a === 0)
  },
  {
    id: "l0_bool_is_pos",
    level: 0,
    op: "is_pos",
    category: "logic",
    description: "Check if number > 0",
    expectedArgs: ["$a"],
    sampleInputs: [{ $a: 5 }, { $a: 0 }, { $a: -2 }],
    fuzzValidator: (val, inp) => Boolean(val) === (inp.$a > 0)
  },
  {
    id: "l0_bool_is_neg",
    level: 0,
    op: "is_neg",
    category: "logic",
    description: "Check if number < 0",
    expectedArgs: ["$a"],
    sampleInputs: [{ $a: -4 }, { $a: 0 }, { $a: 6 }],
    fuzzValidator: (val, inp) => Boolean(val) === (inp.$a < 0)
  },
  {
    id: "l0_bool_in_range",
    level: 0,
    op: "in_range",
    category: "logic",
    description: "Check if $x >= $min and $x <= $max",
    expectedArgs: ["$x", "$min", "$max"],
    sampleInputs: [{ $x: 5, $min: 0, $max: 10 }, { $x: -1, $min: 0, $max: 10 }, { $x: 10, $min: 0, $max: 10 }],
    fuzzValidator: (val, inp) => Boolean(val) === (inp.$x >= inp.$min && inp.$x <= inp.$max)
  },

  // --- LEVEL 0: STRING & BYTE TOKENS ---
  {
    id: "l0_str_wrap",
    level: 0,
    op: "str_wrap",
    category: "string",
    description: "Wrap string: concat $prefix $str $suffix",
    expectedArgs: ["$str", "$prefix", "$suffix"],
    sampleInputs: [{ $str: "hello", $prefix: "[", $suffix: "]" }, { $str: "token", $prefix: "sha256:", $suffix: "" }],
    fuzzValidator: (val, inp) => val === `${inp.$prefix}${inp.$str}${inp.$suffix}`
  },
  {
    id: "l0_str_join2",
    level: 0,
    op: "join2",
    category: "string",
    description: "Join two tokens with delimiter: concat $a $delim $b",
    expectedArgs: ["$a", "$b", "$delim"],
    sampleInputs: [{ $a: "foo", $b: "bar", $delim: ":" }, { $a: "lvl", $b: "0", $delim: ":" }],
    fuzzValidator: (val, inp) => val === `${inp.$a}${inp.$delim}${inp.$b}`
  },
  {
    id: "l0_str_is_empty",
    level: 0,
    op: "is_empty",
    category: "string",
    description: "Check if length of string or list equals 0",
    expectedArgs: ["$target"],
    sampleInputs: [{ $target: "" }, { $target: "abc" }, { $target: [] }],
    fuzzValidator: (val, inp) => Boolean(val) === (inp.$target.length === 0)
  },

  // --- LEVEL 1: CONTROL FLOW & METAPROGRAMMING ---
  {
    id: "l1_ctrl_when",
    level: 1,
    op: "when",
    category: "control",
    description: "One-armed conditional: if $cond return $action else null",
    expectedArgs: ["$cond", "$action"],
    sampleInputs: [{ $cond: true, $action: 42 }, { $cond: false, $action: 42 }],
    fuzzValidator: (val, inp) => val === (inp.$cond ? inp.$action : null)
  },
  {
    id: "l1_ctrl_unless",
    level: 1,
    op: "unless",
    category: "control",
    description: "Inverse conditional: if not($cond) return $action else null",
    expectedArgs: ["$cond", "$action"],
    sampleInputs: [{ $cond: false, $action: "fired" }, { $cond: true, $action: "fired" }],
    fuzzValidator: (val, inp) => val === (!inp.$cond ? inp.$action : null)
  },
  {
    id: "l1_ctrl_default",
    level: 1,
    op: "default",
    category: "control",
    description: "Default fallback: if $val is null or empty return $fallback else $val",
    expectedArgs: ["$val", "$fallback"],
    sampleInputs: [{ $val: null, $fallback: "default_val" }, { $val: "custom", $fallback: "default_val" }],
    fuzzValidator: (val, inp) => val === (inp.$val !== null ? inp.$val : inp.$fallback)
  },
  {
    id: "l1_ctrl_guard",
    level: 1,
    op: "guard",
    category: "security",
    description: "Security assertion: if $predicate is true return $value else return false",
    expectedArgs: ["$predicate", "$value"],
    sampleInputs: [{ $predicate: true, $value: "secret_data" }, { $predicate: false, $value: "secret_data" }],
    fuzzValidator: (val, inp) => val === (inp.$predicate ? inp.$value : false)
  },
  {
    id: "l1_ctrl_compose2",
    level: 1,
    op: "compose2",
    category: "composition",
    description: "Compute ($x + 10) * 2 using L0 primitives",
    expectedArgs: ["$x"],
    sampleInputs: [{ $x: 5 }, { $x: 10 }, { $x: -5 }],
    fuzzValidator: (val, inp) => val === (inp.$x + 10) * 2
  },
  {
    id: "l1_ctrl_linear_scale",
    level: 1,
    op: "linear_scale",
    category: "composition",
    description: "Linear equation ($m * $x) + $b",
    expectedArgs: ["$m", "$x", "$b"],
    sampleInputs: [{ $m: 2, $x: 5, $b: 3 }, { $m: 10, $x: 4, $b: -5 }],
    fuzzValidator: (val, inp) => val === inp.$m * inp.$x + inp.$b
  },
  {
    id: "l1_ctrl_diff_ratio",
    level: 1,
    op: "diff_ratio",
    category: "math",
    description: "Ratio of difference to sum: ($a - $b) / ($a + $b)",
    expectedArgs: ["$a", "$b"],
    sampleInputs: [{ $a: 20, $b: 5 }, { $a: 10, $b: 2 }],
    fuzzValidator: (val, inp) => val === (inp.$a - inp.$b) / (inp.$a + inp.$b)
  }
];
