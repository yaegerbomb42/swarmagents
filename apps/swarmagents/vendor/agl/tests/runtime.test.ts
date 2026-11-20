import { Lexer } from '../src/lexer.ts';
import { Parser } from '../src/parser.ts';
import { ExecutionContext } from '../src/runtime/context.ts';
import { Evaluator } from '../src/runtime/evaluator.ts';

async function run() {
  console.log('--- AGL TEST SUITE ---');

  // Test 1
  const p1 = new Parser('(lvl:0:add 10 20)');
  const ast1 = p1.parse();
  if (ast1.op !== 'add' || ast1.level !== 0 || ast1.args?.length !== 2) {
    throw new Error('Test 1 failed: parse structure');
  }
  console.log('✓ Test 1: Parser AST passed');

  // Test 2
  const evalr = new Evaluator();
  const ctx = new ExecutionContext();
  const res1 = await evalr.evaluate(ast1, ctx);
  if (res1 !== 30) throw new Error(`Test 2 failed: expected 30 got ${res1}`);
  console.log('✓ Test 2: Base L0 evaluation passed (10 + 20 = 30)');

  // Test 3: Nested expression
  const ast3 = new Parser('(lvl:0:mul (lvl:0:add 5 5) (lvl:0:sub 10 6))').parse();
  const res3 = await evalr.evaluate(ast3, ctx);
  if (res3 !== 40) throw new Error(`Test 3 failed: expected 40 got ${res3}`);
  console.log('✓ Test 3: Nested L0 evaluation passed ( (5+5)*(10-6) = 40 )');

  // Test 4: L1 Dynamic Modify hook
  const modifyCode = `(lvl:1:modify "lvl:0:add" "(lvl:0:mul (lvl:0:add $a $b) 2)" "sha256:verified_override")`;
  const modAst = new Parser(modifyCode).parse();
  await evalr.evaluate(modAst, ctx);

  const hookedRes = await evalr.evaluate(ast1, ctx);
  if (hookedRes !== 60) throw new Error(`Test 4 failed: expected 60 got ${hookedRes}`);
  console.log('✓ Test 4: L1 Metaprogramming Modify hook passed ((10 + 20) * 2 = 60)');

  // Test 5: Pipeline evaluation
  const pipeAst = new Parser('(lvl:2:pipeline (lvl:0:sub 20 5) (lvl:0:mul $in 3))').parse();
  const pipeRes = await evalr.evaluate(pipeAst, ctx);
  if (pipeRes !== 45) throw new Error(`Test 5 failed: expected 45 got ${pipeRes}`);
  console.log('✓ Test 5: L2 Pipeline execution passed ((20-5)*3 = 45)');

  console.log('\nALL 5 AGL RUNTIME TESTS PASSED DETERMINISTICALLY!');
}

run().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
